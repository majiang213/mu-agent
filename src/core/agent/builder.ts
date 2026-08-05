import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import type { TextContent, ImageContent } from '@earendil-works/pi-ai';
import type { CustomToolCallEvent, ToolResultEvent } from '@earendil-works/pi-coding-agent';

import { runEditPostCheck } from '../../tool/safety/modification.js';
import { resolveProjectPath } from '../../tool/safety/paths.js';
import { StagnationDetector } from '../cognitive/index.js';
import { compactLoopMessages } from '../compaction/index.js';
import { DEFAULT_MAX_FILES_PER_TASK } from '../../config/defaults.js';
import type { ExecutionEvent, RunConfig } from './types.js';
import { State } from '../types.js';

/**
 * The one SteerMessage shape. Every nudge to a running agent — complete()
 * reminders, post-check guidance, stagnation warnings — goes through here so
 * the message construction has a single home (round-4 driver consolidation).
 * Lives beside buildStepAgent/subscribeStepEvents: Agent-primitive shaping is
 * this module's vocabulary, and reason-runner.ts already depends on it.
 */
export function steer(agent: Agent, content: string): void {
  agent.steer({ role: 'steer', content, timestamp: Date.now() });
}

/** Content-part shape every pi message/tool-result shares. */
type ContentPart = { type: string; text?: string; thinking?: string };

/**
 * "What is visible text" has ONE home (round-8, candidate 4): flatten a
 * content-part array down to the text (or thinking) strings. Used by the
 * streamFn prompt snapshot, tool_execution_end output, message_update
 * streaming, and turn_end finalization — previously four near-copies.
 */
function flattenParts(parts: ContentPart[], kind: 'text' | 'thinking'): string[] {
  return parts.flatMap((c) => {
    if (c.type !== kind) return [];
    const v = kind === 'text' ? c.text : c.thinking;
    return v ? [v] : [];
  });
}

/** Think-block stripping: closed blocks everywhere; the streaming path also
 * strips a trailing unclosed block (mid-stream partial). */
const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/g;
const THINK_OPEN_RE = /<think>[\s\S]*$/;

export function buildStepAgent(
  systemPrompt: string,
  initialMessages: AgentMessage[],
  cfg: RunConfig,
  onEvent: ((event: ExecutionEvent) => void) | undefined,
  tools: AgentTool[],
  readFiles?: Set<string>,
): Agent {
  let agentRef: Agent | null = null;
  // Extensions read ctx.getSystemPrompt() at call time (Gap 85-A).
  if (cfg.extensionHost) cfg.extensionHost.systemPrompt = systemPrompt;
  const runner = cfg.extensionRunner;

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
            ? flattenParts(lastUserMsg.content as ContentPart[], 'text').join('\n')
            : typeof lastUserMsg.content === 'string'
              ? lastUserMsg.content
              : ''
          : '';
      if (!(opts as { signal?: AbortSignal })?.signal?.aborted) {
        onEvent?.({ type: 'turn_start', systemPrompt: agentCtx.systemPrompt ?? '', userPrompt: userPromptText });
      }
      return cfg.models.streamSimple(m, agentCtx, { ...opts, temperature: cfg.temperature });
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
          // THE containment check (tool/safety/paths.ts) — normalized, so the
          // checkpoint key is canonical and post-check lookups match.
          const resolved = resolveProjectPath(cfg.projectRoot, filePath);
          if (!resolved.ok) {
            return { block: true, reason: `Path traversal blocked: ${filePath} is outside project root` };
          }
          try {
            await cfg.safeModifier.createCheckpoint(resolved.abs, cfg.stateMachine);
          } catch (e) {
            console.warn('[SafeModifier] createCheckpoint failed for', filePath, ':', e);
            return { block: true, reason: '[SafeModifier] Cannot create checkpoint: ' + String(e) };
          }
        }
      }
      // Gap 85-A: extension tool_call interception (block + in-place input
      // mutation — toolCtx.args is the SAME object execute() receives, so
      // handler mutations land, pi-compatible). complete() is observe-only
      // (decision ①): handlers get a CLONE, so neither block nor mutation can
      // cut the state machine exit; attempts are warned, not honored.
      if (runner?.hasHandlers('tool_call')) {
        const isComplete = toolName === 'complete';
        const event: CustomToolCallEvent = {
          type: 'tool_call',
          toolCallId: toolCtx.toolCall.id,
          toolName,
          input: isComplete
            ? structuredClone(toolCtx.args as Record<string, unknown>)
            : (toolCtx.args as Record<string, unknown>),
        };
        try {
          const result = await runner.emitToolCall(event);
          if (result?.block) {
            if (isComplete) {
              cfg.extensionHost?.notify?.(
                '[extensions] tool_call block on complete() ignored (state exit protected)',
                'warning',
              );
            } else {
              return { block: true, reason: result.reason ?? 'Blocked by extension' };
            }
          }
        } catch (e) {
          // Fail-closed (decision ④): a throwing handler blocks the call —
          // except complete(), whose exit protection outranks fail-closed.
          const msg = e instanceof Error ? e.message : String(e);
          if (isComplete) {
            cfg.extensionHost?.notify?.(`[extensions] tool_call handler threw on complete(): ${msg}`, 'warning');
          } else {
            return { block: true, reason: `[extensions] tool_call handler failed: ${msg}` };
          }
        }
      }
      return undefined;
    },
    afterToolCall: async (toolCtx) => {
      if (toolCtx.toolCall.name === 'complete' && !toolCtx.isError) {
        agentRef?.abort();
      }
      // Gap 84 F1: a block from wrapWithGitGuard (tool/safety/git-guard.ts)
      // signals a disallowed git command. The guard returns a non-throwing
      // result whose STRUCTURED details carry `{ gitGuardBlocked: true }` —
      // the model-facing text keeps the `[GIT GUARD]` guidance, the harness
      // signal rides the structured channel (no text grepping). Since the
      // guard has no agent ref, detect the block here (where agentRef IS
      // available) and hard-abort the turn, defeating the iteration attack
      // regardless of parallel batching.
      if (toolCtx.toolCall.name === 'bash' && !toolCtx.isError) {
        const details = (toolCtx.result as { details?: unknown } | undefined)?.details;
        const blocked =
          details !== null &&
          typeof details === 'object' &&
          (details as { gitGuardBlocked?: unknown }).gitGuardBlocked === true;
        if (blocked) {
          agentRef?.abort();
          return toolCtx.result;
        }
      }
      let workingResult = toolCtx.result as
        { content?: Array<TextContent | ImageContent>; details?: unknown } | undefined;
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
            const existing = workingResult?.content ?? [{ type: 'text' as const, text: 'ok' }];
            const lspText = errors.join('\n');
            const existingText = existing.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');
            workingResult = {
              ...workingResult,
              content: [{ type: 'text' as const, text: `${existingText}\n${lspText}` }],
            };
          }
        }
      }
      // Gap 85-A: extension tool_result interception (content/details rewrite).
      // Handler errors are isolated inside emitToolResult. complete() rewrites
      // are ignored — the exit protocol's result is harness-owned (decision ①).
      if (runner?.hasHandlers('tool_result')) {
        const isComplete = toolCtx.toolCall.name === 'complete';
        const event = {
          type: 'tool_result',
          toolCallId: toolCtx.toolCall.id,
          toolName: toolCtx.toolCall.name,
          input: toolCtx.args as Record<string, unknown>,
          content: workingResult?.content ?? [],
          isError: toolCtx.isError,
          details: workingResult?.details,
        } as ToolResultEvent;
        const rewritten = await runner.emitToolResult(event);
        if (rewritten) {
          if (isComplete) {
            cfg.extensionHost?.notify?.(
              '[extensions] tool_result rewrite on complete() ignored (state exit protected)',
              'warning',
            );
          } else {
            workingResult = {
              ...workingResult,
              ...(rewritten.content !== undefined ? { content: rewritten.content } : {}),
              ...(rewritten.details !== undefined ? { details: rewritten.details } : {}),
            };
          }
        }
      }
      return workingResult === toolCtx.result ? undefined : workingResult;
    },
    transformContext: async (messages) => {
      const latestSteerIdx = messages.findLastIndex((m) => m.role === 'steer');
      const result =
        latestSteerIdx < 0 ? messages : messages.filter((m, i) => m.role !== 'steer' || i === latestSteerIdx);
      const inLoopBudget = Math.floor(cfg.model.contextWindow * cfg.contextRatio);
      const compacted = compactLoopMessages(result, inLoopBudget);
      // Gap 85-A: extension context event — handlers see (and may replace) the
      // FINAL message list the LLM call receives. Fail-open: a broken context
      // handler must not kill the turn (pi isolates handler errors the same way).
      if (runner?.hasHandlers('context')) {
        try {
          return await runner.emitContext(compacted);
        } catch (e) {
          cfg.extensionHost?.notify?.(
            `[extensions] context handler failed: ${e instanceof Error ? e.message : String(e)}`,
            'warning',
          );
        }
      }
      return compacted;
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

/** Step-event subscriptions, options-object style: absent means "not interested". */
export interface StepEventCallbacks {
  onLlmText?: (text: string) => void;
  onEvent?: (event: ExecutionEvent) => void;
  onTurnEndComplete?: () => void;
}

export function subscribeStepEvents(
  agent: Agent,
  state: State,
  stagnationDetector: StagnationDetector,
  cfg: RunConfig,
  callbacks: StepEventCallbacks = {},
): void {
  const { onLlmText, onEvent, onTurnEndComplete } = callbacks;
  const pendingModifyPaths = new Map<string, string>();
  let stagnationWarnings = 0;

  // Gap 85-A: forward pi-agent-core's observation events to extension
  // handlers. hasHandlers short-circuits every emit, so a run without
  // extensions (or without a handler for that event) pays nothing. emit()
  // isolates handler errors internally; the trailing catch is paranoia for
  // runner-level failures — observation must never break a step.
  const extRunner = cfg.extensionRunner;
  let turnIndex = 0;
  const emitObserve = (event: Parameters<NonNullable<typeof extRunner>['emit']>[0]): void => {
    if (!extRunner?.hasHandlers(event.type)) return;
    void extRunner.emit(event).catch(() => {});
  };

  agent.subscribe((event: AgentEvent) => {
    if (event.type === 'agent_start') {
      emitObserve({ type: 'agent_start' });
    }

    if (event.type === 'agent_end') {
      emitObserve({ type: 'agent_end', messages: event.messages });
    }

    if (event.type === 'turn_start') {
      turnIndex++;
      emitObserve({ type: 'turn_start', turnIndex, timestamp: Date.now() });
    }

    if (event.type === 'message_start') {
      emitObserve({ type: 'message_start', message: event.message });
    }

    if (event.type === 'message_end') {
      // message_end has a dedicated emitter (excluded from generic emit).
      if (extRunner?.hasHandlers('message_end')) {
        void extRunner.emitMessageEnd({ type: 'message_end', message: event.message }).catch(() => {});
      }
    }

    if (event.type === 'tool_execution_start') {
      emitObserve({
        type: 'tool_execution_start',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
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
      });
      if (event.toolName === 'edit' || event.toolName === 'write') {
        const args = event.args as Record<string, unknown>;
        const fp = typeof args['path'] === 'string' ? args['path'] : null;
        if (fp) {
          // Store the RESOLVED path so the post-check's hasCheckpoint lookup
          // hits the checkpoint key created in beforeToolCall — raw relative
          // args never matched the resolved key, silently skipping the
          // post-edit damage check for relative-path edits.
          const resolved = resolveProjectPath(cfg.projectRoot, fp);
          if (resolved.ok) pendingModifyPaths.set(event.toolCallId, resolved.abs);
        }
      }
    }

    if (event.type === 'tool_execution_end') {
      emitObserve({
        type: 'tool_execution_end',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      });
      const rawOutput =
        event.result &&
        typeof event.result === 'object' &&
        Array.isArray((event.result as { content?: unknown }).content)
          ? flattenParts((event.result as { content: ContentPart[] }).content, 'text')
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
                steer(agent, steerMessage);
              }
            }
          })
          .catch((checkErr) => {
            console.warn('[SafeModifier] Post-check pipeline failed for', filePath, ':', checkErr);
          });
      }
    }

    if (event.type === 'message_update') {
      emitObserve({
        type: 'message_update',
        message: event.message,
        assistantMessageEvent: event.assistantMessageEvent,
      });
      // pi-agent-core's AgentEvent union does not type these payloads — the
      // structural shape is asserted here (upstream type gap, documented).
      const ae = (event as unknown as { assistantMessageEvent?: { type: string } }).assistantMessageEvent;
      const msg = (event as unknown as { message?: { content?: ContentPart[] } }).message;
      if (msg?.content) {
        if (ae?.type === 'thinking_delta' || ae?.type === 'thinking_start') {
          const thinking = flattenParts(msg.content, 'thinking').join('');
          if (thinking) onEvent?.({ type: 'message_thinking_update', content: thinking });
        }
        if (ae?.type === 'text_delta' || ae?.type === 'text_start') {
          const text = flattenParts(msg.content, 'text')
            .join('')
            .replace(THINK_BLOCK_RE, '')
            .replace(THINK_OPEN_RE, '');
          if (text) onEvent?.({ type: 'message_update', content: text });
        }
      }
    }

    if (event.type === 'turn_end') {
      emitObserve({
        type: 'turn_end',
        turnIndex,
        message: event.message,
        toolResults: event.toolResults,
      });
      const msg = event.message;
      if (msg && 'content' in msg && Array.isArray(msg.content)) {
        const parts = msg.content as ContentPart[];
        const thinking = flattenParts(parts, 'thinking');
        const text = flattenParts(parts, 'text');
        if (thinking.length > 0) onEvent?.({ type: 'message_thinking_end', content: thinking.join('\n') });
        if (text.length > 0) {
          const joined = text.join('\n').replace(THINK_BLOCK_RE, '').trim();
          if (joined) {
            onEvent?.({ type: 'message_end', content: joined });
            onLlmText?.(joined);
          }
        }
      }
      const usage = msg && 'usage' in msg ? (msg as { usage?: { input?: number; output?: number } }).usage : null;
      const inputTokens = usage?.input ?? 0;
      onEvent?.({
        type: 'turn_end',
        promptLen: inputTokens,
        responseLen: usage?.output ?? 0,
      });

      {
        const stagnationResult = stagnationDetector.check();
        if (stagnationResult?.detected) {
          if (stagnationWarnings >= 1) {
            agent.abort();
          } else {
            stagnationWarnings++;
            stagnationDetector.reset();
            steer(agent, `[STAGNATION DETECTED] ${stagnationResult.message}. ${stagnationResult.suggestion ?? ''}`);
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
