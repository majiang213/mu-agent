import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai';

import { runEditPostCheck } from '../../tool/safety/modification.js';
import { StagnationDetector } from '../cognitive/index.js';
import { ContextCompactor } from '../compaction/index.js';
import { DEFAULT_MAX_FILES_PER_TASK } from '../../config/defaults.js';
import type { ExecutionEvent, RunConfig } from './types.js';
import { State } from '../types.js';

export function buildStepAgent(
  systemPrompt: string,
  initialMessages: AgentMessage[],
  cfg: RunConfig,
  onEvent: ((event: ExecutionEvent) => void) | undefined,
  tools: AgentTool[],
  readFiles?: Set<string>,
): Agent {
  let agentRef: Agent | null = null;

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: cfg.model,
      tools,
      ...(initialMessages.length > 0 ? { messages: initialMessages } : {}),
    },
    streamFn: async (m, agentCtx, opts) => {
      const lastUserMsg = agentCtx.messages.findLast((msg) => msg.role === 'user');
      const userPromptText =
        lastUserMsg && 'content' in lastUserMsg
          ? Array.isArray(lastUserMsg.content)
            ? (lastUserMsg.content as Array<{ type: string; text?: string }>)
                .flatMap((c) => (c.type === 'text' && c.text ? [c.text as string] : []))
                .join('\n')
            : typeof lastUserMsg.content === 'string'
              ? lastUserMsg.content
              : ''
          : '';
      if (!(opts as { signal?: AbortSignal })?.signal?.aborted) {
        onEvent?.({ type: 'turn_start', systemPrompt: agentCtx.systemPrompt ?? '', userPrompt: userPromptText });
      }
      return streamSimple(m, agentCtx, { ...opts, apiKey: cfg.apiKey, temperature: cfg.temperature });
    },
    getApiKey: () => cfg.apiKey,
    beforeToolCall: async (toolCtx) => {
      const toolName = toolCtx.toolCall.name;
      if (toolName === 'read' && readFiles) {
        const args = toolCtx.args as Record<string, unknown>;
        const fp = typeof args['filePath'] === 'string' ? args['filePath'] : null;
        if (fp) {
          if (readFiles.has(fp)) {
            return {
              block: true,
              reason: `Already read: ${fp}. Do not re-read. Already read files: ${[...readFiles].join(', ')}.`,
            };
          }
          readFiles.add(fp);
        }
      }
      if (toolName === 'edit' || toolName === 'write') {
        const maxFiles = cfg.safetyConfig.maxFilesPerTask ?? DEFAULT_MAX_FILES_PER_TASK;
        if (!cfg.stateMachine.canModifyMoreFiles(maxFiles)) {
          return {
            block: true,
            reason: `File modification limit reached (max ${maxFiles} files per task).`,
          };
        }
      }
      if ((toolName === 'edit' || toolName === 'write') && (cfg.safetyConfig.enableCheckpoint ?? true)) {
        const args = toolCtx.args as Record<string, unknown>;
        const filePath = typeof args['path'] === 'string' ? args['path'] : null;
        if (filePath) {
          const resolved = filePath.startsWith('/') ? filePath : `${cfg.projectRoot}/${filePath}`;
          if (!resolved.startsWith(cfg.projectRoot)) {
            return { block: true, reason: `Path traversal blocked: ${filePath} is outside project root` };
          }
          try {
            await cfg.safeModifier.createCheckpoint(resolved, cfg.stateMachine);
          } catch (e) {
            console.warn('[SafeModifier] createCheckpoint failed for', filePath, ':', e);
            return { block: true, reason: '[SafeModifier] Cannot create checkpoint: ' + String(e) };
          }
        }
      }
      return undefined;
    },
    afterToolCall: async (toolCtx) => {
      if (toolCtx.toolCall.name === 'complete' && !toolCtx.isError) {
        agentRef?.abort();
      }
      // Gap 84 F1: a `[GIT GUARD]` block from wrapWithGitGuard (tool/safety/
      // git-guard.ts) signals a disallowed git command. The guard returns a
      // text result (no throw, no terminate), so the agent loop would
      // otherwise let the model iterate obfuscated variants within the same
      // step. Since the guard has no agent ref, detect the block marker here
      // (where agentRef IS available) and hard-abort the turn. This defeats
      // the iteration attack regardless of parallel batching.
      if (toolCtx.toolCall.name === 'bash' && !toolCtx.isError) {
        const bashContent = toolCtx.result?.content;
        const bashText = Array.isArray(bashContent)
          ? bashContent.flatMap((c) => (c && c.type === 'text' && c.text ? [c.text as string] : [])).join('\n')
          : '';
        if (bashText.startsWith('[GIT GUARD]')) {
          agentRef?.abort();
          return toolCtx.result;
        }
      }
      if (
        cfg.lspClient &&
        (toolCtx.toolCall.name === 'edit' || toolCtx.toolCall.name === 'write') &&
        !toolCtx.isError
      ) {
        const args = toolCtx.args as Record<string, unknown>;
        const filePath = typeof args['path'] === 'string' ? args['path'] : null;
        if (filePath) {
          const errors = await cfg.lspClient.touchFile(filePath);
          if (errors.length > 0) {
            const existing = toolCtx.result.content ?? [{ type: 'text' as const, text: 'ok' }];
            const lspText = errors.join('\n');
            const existingText = existing
              .flatMap((c) => (c.type === 'text' && c.text ? [c.text as string] : []))
              .join('');
            return {
              content: [{ type: 'text' as const, text: `${existingText}\n${lspText}` }],
            };
          }
        }
      }
      return undefined;
    },
    transformContext: async (messages) => {
      const latestSteerIdx = messages.findLastIndex((m) => m.role === 'steer');
      const result =
        latestSteerIdx < 0 ? messages : messages.filter((m, i) => m.role !== 'steer' || i === latestSteerIdx);
      const inLoopBudget = Math.floor(cfg.model.contextWindow * cfg.contextRatio);
      const compactor = new ContextCompactor({ maxTokens: inLoopBudget });
      return compactor.compact(result).messages;
    },
    convertToLlm: (messages) => {
      return messages.flatMap((m) => {
        if (m.role === 'steer') {
          const sm = m as import('../types.js').SteerMessage;
          return [{ role: 'user' as const, content: sm.content, timestamp: sm.timestamp }];
        }
        return [m as import('@earendil-works/pi-ai').Message];
      });
    },
  });

  agentRef = agent;
  return agent;
}

export function subscribeStepEvents(
  agent: Agent,
  state: State,
  stagnationDetector: StagnationDetector,
  cfg: RunConfig,
  onLlmText: (text: string) => void,
  onEvent?: (event: ExecutionEvent) => void,
  onTurnEndComplete?: () => void,
): void {
  const pendingModifyPaths = new Map<string, string>();
  let stagnationWarnings = 0;

  agent.subscribe((event: AgentEvent) => {
    if (event.type === 'tool_execution_start') {
      onEvent?.({
        type: 'tool_execution_start',
        tool: event.toolName,
        toolId: event.toolCallId,
        args: event.args as Record<string, unknown>,
      });
      cfg.stateMachine.recordToolCall(event.toolName);
      stagnationDetector.recordToolCall({
        tool: event.toolName,
        input: event.args,
        output: null,
        timestamp: Date.now(),
      });
      if (event.toolName === 'edit' || event.toolName === 'write') {
        const args = event.args as Record<string, unknown>;
        const fp = typeof args['path'] === 'string' ? args['path'] : null;
        if (fp) pendingModifyPaths.set(event.toolCallId, fp);
      }
    }

    if (event.type === 'tool_execution_end') {
      const rawOutput =
        event.result &&
        typeof event.result === 'object' &&
        Array.isArray((event.result as { content?: unknown }).content)
          ? (event.result as { content: Array<{ type: string; text?: string }> }).content
              .flatMap((c) => (c.type === 'text' && c.text ? [c.text as string] : []))
              .join('\n')
              .slice(0, 3000)
          : undefined;
      onEvent?.({
        type: 'tool_execution_end',
        tool: event.toolName,
        toolId: event.toolCallId,
        isError: event.isError,
        output: rawOutput || undefined,
      });
      const filePath = pendingModifyPaths.get(event.toolCallId);
      pendingModifyPaths.delete(event.toolCallId);
      if (event.isError && event.toolName !== 'bash') stagnationDetector.recordError(`tool_error:${event.toolName}`);
      if (
        filePath &&
        !event.isError &&
        (cfg.safetyConfig.enableCheckpoint ?? true) &&
        cfg.safeModifier.hasCheckpoint(filePath)
      ) {
        void runEditPostCheck(cfg.safeModifier, filePath)
          .then(({ ok, steerMessage }) => {
            if (!ok) {
              stagnationDetector.recordError(`post_check_failed:${filePath}`);
              if (steerMessage) {
                agent.steer({
                  role: 'steer',
                  content: steerMessage,
                  timestamp: Date.now(),
                });
              }
            }
          })
          .catch((checkErr) => {
            console.warn('[SafeModifier] Post-check pipeline failed for', filePath, ':', checkErr);
          });
      }
    }

    if (event.type === 'message_update') {
      // pi-agent-core's AgentEvent union does not type these payloads — the
      // structural shape is asserted here (upstream type gap, documented).
      const ae = (event as unknown as { assistantMessageEvent?: { type: string } }).assistantMessageEvent;
      const msg = (
        event as unknown as { message?: { content?: Array<{ type: string; text?: string; thinking?: string }> } }
      ).message;
      if (msg?.content) {
        const parts = msg.content;
        if (ae?.type === 'thinking_delta' || ae?.type === 'thinking_start') {
          const thinking = parts
            .flatMap((c) => (c.type === 'thinking' && c.thinking ? [c.thinking as string] : []))
            .join('');
          if (thinking) onEvent?.({ type: 'message_thinking_update', content: thinking });
        }
        if (ae?.type === 'text_delta' || ae?.type === 'text_start') {
          const text = parts
            .flatMap((c) => (c.type === 'text' && c.text ? [c.text as string] : []))
            .join('')
            .replace(/<think>[\s\S]*?<\/think>/g, '')
            .replace(/<think>[\s\S]*$/, '');
          if (text) onEvent?.({ type: 'message_update', content: text });
        }
      }
    }

    if (event.type === 'turn_end') {
      const msg = event.message;
      if (msg && 'content' in msg && Array.isArray(msg.content)) {
        const parts = msg.content as Array<{ type: string; text?: string; thinking?: string }>;
        const thinking = parts.flatMap((c) => (c.type === 'thinking' && c.thinking ? [c.thinking as string] : []));
        const text = parts.flatMap((c) => (c.type === 'text' && c.text ? [c.text as string] : []));
        if (thinking.length > 0) onEvent?.({ type: 'message_thinking_end', content: thinking.join('\n') });
        if (text.length > 0) {
          const joined = text
            .join('\n')
            .replace(/<think>[\s\S]*?<\/think>/g, '')
            .trim();
          if (joined) {
            onEvent?.({ type: 'message_end', content: joined });
            onLlmText(joined);
          }
        }
      }
      const usage = msg && 'usage' in msg ? (msg as { usage?: { input?: number; output?: number } }).usage : null;
      const inputTokens = usage?.input ?? 0;
      onEvent?.({
        type: 'turn_end',
        promptLen: inputTokens,
        responseLen: usage?.output ?? 0,
        contextTokens: inputTokens,
      });

      {
        const stagnationResult = stagnationDetector.check();
        if (stagnationResult?.detected) {
          if (stagnationWarnings >= 1) {
            agent.abort();
          } else {
            stagnationWarnings++;
            stagnationDetector.reset();
            agent.steer({
              role: 'steer',
              content: `[STAGNATION DETECTED] ${stagnationResult.message}. ${stagnationResult.suggestion ?? ''}`,
              timestamp: Date.now(),
            });
          }
        }
        // Reset warning count when agent makes progress (no stagnation this turn)
        if (!stagnationResult?.detected) {
          stagnationWarnings = 0;
        }
      }

      onTurnEndComplete?.();
    }
  });
}
