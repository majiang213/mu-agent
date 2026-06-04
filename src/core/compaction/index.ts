import { encode } from 'gpt-tokenizer';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';
import { completeSimple } from '@mariozechner/pi-ai';
import { DEFAULT_CONTEXT_RATIO } from '../../config/defaults.js';

export interface CompactionConfig {
  maxTokens: number;
  preserveFirstN: number;
  preserveLastN: number;
  minMessagesToCompact: number;
}

export interface CompactionResult {
  compacted: boolean;
  originalCount: number;
  compactedCount: number;
  removedCount: number;
  messages: AgentMessage[];
}

function isSteerMessage(msg: AgentMessage): boolean {
  return msg.role === 'steer';
}

function estimateTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, msg) => {
    const c = (msg as { content?: unknown }).content;
    const text = typeof c === 'string' ? c : JSON.stringify(c ?? '');
    return sum + encode(text).length;
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

export class ContextCompactor {
  private config: CompactionConfig;

  constructor(config: Partial<CompactionConfig> = {}) {
    this.config = {
      maxTokens: 4000,
      preserveFirstN: 2,
      preserveLastN: 6,
      minMessagesToCompact: 10,
      ...config,
    };
  }

  shouldCompact(messages: AgentMessage[]): boolean {
    if (messages.length < this.config.minMessagesToCompact) return false;
    return estimateTokens(messages) > this.config.maxTokens;
  }

  compact(messages: AgentMessage[]): CompactionResult {
    if (!this.shouldCompact(messages)) {
      return {
        compacted: false,
        originalCount: messages.length,
        compactedCount: messages.length,
        removedCount: 0,
        messages,
      };
    }

    const { preserveFirstN, preserveLastN } = this.config;
    const total = messages.length;
    const head = messages.slice(0, preserveFirstN);
    const tail = messages.slice(-preserveLastN);
    const middle = messages.slice(preserveFirstN, total - preserveLastN);

    const compressed = middle.filter((m) => !isSteerMessage(m)).map((m) => compressMessage(m));

    const result: AgentMessage[] = [...head, ...compressed, ...tail];

    return {
      compacted: true,
      originalCount: total,
      compactedCount: result.length,
      removedCount: total - result.length,
      messages: result,
    };
  }

  estimateTokens(messages: AgentMessage[]): number {
    return estimateTokens(messages);
  }
}

export function createContextCompactor(config?: Partial<CompactionConfig>): ContextCompactor {
  return new ContextCompactor(config);
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
  apiKey = 'ollama',
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
