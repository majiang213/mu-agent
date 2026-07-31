import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { completeSimple } from '@earendil-works/pi-ai';
import { DEFAULT_CONTEXT_RATIO } from '../../config/defaults.js';
import { OLLAMA_DUMMY_API_KEY } from '../../provider/model-info.js';

// In-loop compaction policy — fixed constants, not config: the only consumer
// (builder.ts transformContext) ever tuned maxTokens; the class wrapper and
// its remaining knobs had no production reader and were collapsed into the
// one function below (round-4 hygiene).
const PRESERVE_FIRST_N = 2;
const PRESERVE_LAST_N = 6;
const MIN_MESSAGES_TO_COMPACT = 10;

function isSteerMessage(msg: AgentMessage): boolean {
  return msg.role === 'steer';
}

function estimateTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, msg) => {
    const c = (msg as { content?: unknown }).content;
    const text = typeof c === 'string' ? c : JSON.stringify(c ?? '');
    return sum + Math.ceil(text.length / 4);
  }, 0);
}

function compressMessage(msg: AgentMessage): AgentMessage {
  const role = msg.role;

  if (role === 'user') {
    const c = (msg as { content?: unknown; timestamp?: number }).content;
    const text = typeof c === 'string' ? c : JSON.stringify(c ?? '');
    const truncated = text.length > 300 ? text.slice(0, 300) + '…' : text;
    return { ...msg, content: truncated } as AgentMessage;
  }

  if (role === 'assistant') {
    const c = (msg as { content?: unknown }).content;
    if (!Array.isArray(c)) return msg;
    const parts: string[] = [];
    for (const block of c as Array<{ type: string; text?: string; name?: string }>) {
      if (block.type === 'text' && block.text) {
        const t = block.text.trim();
        if (t) parts.push(t.length > 200 ? t.slice(0, 200) + '…' : t);
      } else if (block.type === 'toolCall' && block.name) {
        parts.push(`[tool:${block.name}]`);
      }
    }
    return { ...msg, content: [{ type: 'text', text: parts.join(' ') }] } as AgentMessage;
  }

  if (role === 'toolResult') {
    const m = msg as { toolName?: string; isError?: boolean; content?: unknown; role: string };
    const status = m.isError ? '✗' : '✓';
    return {
      ...msg,
      content: [{ type: 'text', text: `${m.toolName ?? 'tool'}${status}` }],
    } as AgentMessage;
  }

  return msg;
}

/**
 * Compact an in-loop message list when its estimated size exceeds maxTokens:
 * preserve head + tail, drop middle steer messages, compress the rest.
 * Returns the input unchanged when under budget.
 */
export function compactLoopMessages(messages: AgentMessage[], maxTokens: number): AgentMessage[] {
  if (messages.length < MIN_MESSAGES_TO_COMPACT || estimateTokens(messages) <= maxTokens) {
    return messages;
  }
  const head = messages.slice(0, PRESERVE_FIRST_N);
  const tail = messages.slice(-PRESERVE_LAST_N);
  const middle = messages.slice(PRESERVE_FIRST_N, messages.length - PRESERVE_LAST_N);
  const compressed = middle.filter((m) => !isSteerMessage(m)).map((m) => compressMessage(m));
  return [...head, ...compressed, ...tail];
}

const SUMMARY_TRIGGER_COUNT = 16;
const SUMMARY_PRESERVE_LAST_N = 8;

function formatMessagesForSummary(messages: AgentMessage[]): string {
  return messages
    .map((m) => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const c = (m as { content?: unknown }).content;
      const text = typeof c === 'string' ? c : JSON.stringify(c ?? '');
      return `${role}: ${text}`;
    })
    .join('\n');
}

export async function compressConversationHistoryWithLLM(
  messages: AgentMessage[],
  model: Model<'openai-completions'>,
  contextRatio = DEFAULT_CONTEXT_RATIO,
  apiKey = OLLAMA_DUMMY_API_KEY,
): Promise<AgentMessage[]> {
  const triggerTokens = Math.floor(model.contextWindow * contextRatio);
  if (messages.length <= SUMMARY_TRIGGER_COUNT && estimateTokens(messages) <= triggerTokens) {
    return messages;
  }

  const tail = messages.slice(-SUMMARY_PRESERVE_LAST_N);
  const head = messages.slice(0, -SUMMARY_PRESERVE_LAST_N);

  if (head.length === 0) return messages;

  try {
    const formatted = formatMessagesForSummary(head);
    const result = await completeSimple(
      model,
      {
        systemPrompt:
          'You are summarizing a conversation history for a coding assistant session. Be concise and factual.',
        messages: [
          {
            role: 'user',
            content: `Summarize the following conversation. Preserve: what tasks the user requested, what was accomplished or changed, any important context for future tasks. Keep under 200 tokens.\n\nConversation:\n${formatted}`,
            timestamp: Date.now(),
          },
        ],
      },
      {
        temperature: 0,
        apiKey,
      },
    );

    const summaryText =
      result.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('') || 'Prior conversation omitted.';

    const summaryMsg = {
      role: 'assistant' as const,
      content: `[Prior conversation summary] ${summaryText}`,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    return [summaryMsg, ...tail];
  } catch {
    return messages;
  }
}
