import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import { streamSimple } from '@mariozechner/pi-ai';
import type { Model } from '@mariozechner/pi-ai';
import { codingTools } from '@mariozechner/pi-coding-agent';
import { StateMachineAgent } from './session.js';
import { State, type StateResult } from './types.js';
import { buildSystemPrompt, buildUserPrompt } from './prompts/index.js';
import { StagnationDetector } from './cognitive/index.js';
import { FailureHandler } from './failure/handler.js';
import { LLMConnector } from '../provider/llm.js';
import { ContextCompactor } from './compaction/index.js';
import { astLocatorTool } from '../tool/locator.js';
import { SafeModifier, syntaxCheckHook, damageCheckHook } from '../tool/safety/index.js';
import { ConfigManager } from '../config/manager.js';

export type ExecutionEvent =
  | { type: 'state_change'; from: string; to: string }
  | { type: 'tool_call'; tool: string; args?: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; isError: boolean }
  | { type: 'llm_output'; content: string }
  | { type: 'llm_thinking'; content: string }
  | { type: 'llm_call'; promptLen: number; responseLen: number; contextTokens: number };

export interface Task {
  id: string;
  description: string;
  state: 'pending' | 'running' | 'completed' | 'failed';
  result?: StateResult;
}

function buildModel(modelName: string, provider: string, baseUrl: string): Model<'openai-completions'> {
  const apiBase = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
  return {
    id: modelName,
    name: modelName,
    api: 'openai-completions',
    provider,
    baseUrl: apiBase,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
  };
}

export class TaskScheduler {
  async executeInput(
    input: string,
    modelName: string,
    provider: string,
    baseUrl: string,
    onEvent?: (event: ExecutionEvent) => void,
    initialMessages?: AgentMessage[],
  ): Promise<StateResult> {
    const task: Task = {
      id: `task-${Date.now()}`,
      description: input,
      state: 'pending',
    };
    return this.executeTask(task, modelName, provider, baseUrl, onEvent, initialMessages);
  }

  async executeTask(
    task: Task,
    modelName: string,
    provider: string,
    baseUrl: string,
    onEvent?: (event: ExecutionEvent) => void,
    initialMessages?: AgentMessage[],
  ): Promise<StateResult> {
    task.state = 'running';

    const stateMachine = new StateMachineAgent(modelName, [astLocatorTool]);

    const model = buildModel(modelName, provider, baseUrl);
    const agentConfig = ConfigManager.getInstance().getConfig();
    const smConfig = agentConfig.stateMachine;
    const safetyConfig = agentConfig.safety;
    const failureConfig = agentConfig.failureHandling;
    const stagnationDetector = new StagnationDetector();
    const contextCompactor = new ContextCompactor({
      maxTokens: smConfig.compactionThreshold > 0 ? smConfig.compactionThreshold * 8 : 24000,
      preserveFirstN: 2,
      preserveLastN: 6,
    });
    const safeModifier = new SafeModifier(agentConfig.system.task.checkpointDir);
    const pendingModifyPaths = new Map<string, string>();
    let stagnationDetected = false;
    let currentTemperature = LLMConnector.DEFAULT_TEMPERATURE;
    let compactionSummary: string | null = null;

    const systemPrompt = buildSystemPrompt({
      state: State.ANALYZE,
      task: task.description,
      modelParams: stateMachine.getModelParams(),
    });

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools: [...codingTools, astLocatorTool],
        ...(initialMessages && initialMessages.length > 0 ? { messages: initialMessages } : {}),
      },
      streamFn: async (m, ctx, opts) => {
        if (compactionSummary !== null) {
          const summary = compactionSummary;
          compactionSummary = null;
          const preserved = ctx.messages.slice(-6);
          const summaryMsg = { role: 'user' as const, content: `[Earlier context summarized]: ${summary}`, timestamp: Date.now() };
          const compactedCtx = { ...ctx, messages: [summaryMsg, ...preserved] };
          return streamSimple(m, compactedCtx, { ...opts, apiKey: 'ollama', temperature: currentTemperature });
        }
        return streamSimple(m, ctx, { ...opts, apiKey: 'ollama', temperature: currentTemperature });
      },
      getApiKey: () => 'ollama',

      beforeToolCall: async (ctx) => {
        const allowedTools = stateMachine.getAllowedTools().map((t) => t.name);
        const toolName = ctx.toolCall.name;
        if (!allowedTools.includes(toolName)) {
          return {
            block: true,
            reason: `State ${stateMachine.getCurrentState()} does not allow tool '${toolName}'. Allowed: ${allowedTools.join(', ')}`,
          };
        }

        if (toolName === 'edit' || toolName === 'write') {
          if (!stateMachine.canModifyMoreFiles(safetyConfig.maxFilesPerTask)) {
            return {
              block: true,
              reason: `File modification limit reached (max ${safetyConfig.maxFilesPerTask} files per task). Switch to VERIFY to review changes.`,
            };
          }
        }

        if ((toolName === 'edit' || toolName === 'write') && safetyConfig.enableCheckpoint) {
          const args = ctx.args as Record<string, unknown>;
          const filePath = typeof args['filePath'] === 'string' ? args['filePath'] : null;
          if (filePath) {
            try {
              await safeModifier.createCheckpoint(filePath);
            } catch {
              // File may not exist yet (write creating new file) — skip checkpoint
            }
          }
        }

        return undefined;
      },
    });

     let turnCount = 0;

    agent.subscribe((event: AgentEvent) => {
      if (event.type === 'tool_execution_start') {
        onEvent?.({ type: 'tool_call', tool: event.toolName, args: event.args as Record<string, unknown> });
        stateMachine.recordToolCall(event.toolName, event.args, null);
        stagnationDetector.recordToolCall({
          tool: event.toolName,
          input: event.args,
          output: null,
          timestamp: Date.now(),
        });

        if (event.toolName === 'edit' || event.toolName === 'write') {
          const args = event.args as Record<string, unknown>;
          const filePath = typeof args['filePath'] === 'string' ? args['filePath'] : null;
          if (filePath) pendingModifyPaths.set(event.toolCallId, filePath);
        }
      }

      if (event.type === 'tool_execution_end') {
        onEvent?.({ type: 'tool_result', tool: event.toolName, isError: event.isError });
        const filePath = pendingModifyPaths.get(event.toolCallId);
        pendingModifyPaths.delete(event.toolCallId);

        if (event.isError) {
          stagnationDetector.recordError(`tool_error:${event.toolName}`);
        }

        if (filePath && !event.isError && safetyConfig.enableCheckpoint && safetyConfig.enablePostCheck && safeModifier.hasCheckpoint(filePath)) {
          const checkpoint = safeModifier.getCheckpoint(filePath);
          const originalContent = checkpoint?.originalContent ?? '';
          Promise.all([
            syntaxCheckHook.check(filePath, originalContent),
            damageCheckHook.check(filePath, originalContent),
          ]).then(([syntaxOk, damageOk]) => {
            if (!syntaxOk || !damageOk) {
              const errMsg = `post_check_failed:${filePath}(syntax=${syntaxOk},damage=${damageOk})`;
              stagnationDetector.recordError(errMsg);
              safeModifier.restore(filePath).then(() => {
                agent.steer({
                  role: 'user',
                  content: [{
                    type: 'text',
                    text: `[SAFE MODIFIER] Post-check failed for ${filePath} (syntax=${syntaxOk}, damage=${damageOk}). File restored. Please try a more conservative edit.`,
                  }],
                  timestamp: Date.now(),
                });
              }).catch(() => {});
            } else {
              safeModifier.clearCheckpoint(filePath);
            }
          }).catch(() => {});
        }
      }

      if (event.type === 'turn_end') {
        turnCount++;
        const msg = event.message;
        if (msg && 'content' in msg && Array.isArray(msg.content)) {
          const parts = msg.content as Array<{ type: string; text?: string; thinking?: string }>;
          const thinkingParts = parts.filter((c) => c.type === 'thinking' && c.thinking).map((c) => c.thinking as string);
          const textParts = parts.filter((c) => c.type === 'text' && c.text).map((c) => c.text as string);
          if (thinkingParts.length > 0) {
            onEvent?.({ type: 'llm_thinking', content: thinkingParts.join('\n') });
          }
          if (textParts.length > 0) {
            onEvent?.({ type: 'llm_output', content: textParts.join('\n') });
          }
        }
        const usage = msg && 'usage' in msg ? (msg as { usage?: { input?: number; output?: number } }).usage : null;
        const inputTokens = usage?.input ?? 0;
        onEvent?.({ type: 'llm_call', promptLen: inputTokens, responseLen: usage?.output ?? 0, contextTokens: inputTokens });

        // Stagnation detection — check after each turn
        const stagnationResult = smConfig.enableStagnationDetector ? stagnationDetector.check() : null;
        if (stagnationResult?.detected) {
          stagnationDetected = true;
          agent.steer({
            role: 'user',
            content: [{
              type: 'text',
              text: `[STAGNATION DETECTED] ${stagnationResult.message}. ${stagnationResult.suggestion}. Stopping current approach.`,
            }],
            timestamp: Date.now(),
          });
          // Force advance to VERIFY or DONE to break the loop
          const currentState = stateMachine.getCurrentState();
          const escapeState = currentState === State.MODIFY || currentState === State.LOCATE
            ? State.VERIFY
            : State.DONE;
          if (escapeState !== currentState) {
            stateMachine.transitionTo(escapeState);
            onEvent?.({ type: 'state_change', from: currentState, to: escapeState });
          }
          return;
        }

        // Context compaction — truncate messages passed to LLM on next turn
        if (smConfig.enableCompaction) {
          const rawMessages = agent.state.messages.map((m) => {
            const content = 'content' in m
              ? (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
              : '';
            return { role: m.role, content };
          });
          const compactionResult = contextCompactor.compact(rawMessages);
          if (compactionResult.compacted && compactionResult.summary) {
            compactionSummary = compactionResult.summary;
          }
        }

        const prevState = stateMachine.getCurrentState();
        if (prevState === State.DONE) return;

        stateMachine.incrementIteration();

        const llmText = msg && 'content' in msg && Array.isArray(msg.content)
          ? (msg.content as Array<{ type: string; text?: string }>)
              .filter((c) => c.type === 'text' && c.text).map((c) => c.text as string).join('\n')
          : '';

        const shouldAdvance = hasStateCompletionJson(prevState, llmText);

        if (shouldAdvance) {
          const nextState = advanceState(prevState);
          if (nextState !== prevState) {
            stateMachine.transitionTo(nextState);
            onEvent?.({ type: 'state_change', from: prevState, to: nextState });

            if (nextState !== State.DONE) {
              const newPrompt = buildSystemPrompt({
                state: nextState,
                task: task.description,
                modelParams: stateMachine.getModelParams(),
              });
              agent.setSystemPrompt(newPrompt);

              agent.steer({
                role: 'user',
                content: [{ type: 'text', text: buildUserPrompt(nextState, task.description) }],
                timestamp: Date.now(),
              });
            }
          }
        }
      }
    });

    const maxRetries = Math.max(stateMachine.getModelParams().maxRetries, failureConfig.maxRetries);
    const failureHandler = new FailureHandler({
      maxRetries,
      onHumanIntervention: failureConfig.enableHumanIntervention
        ? (ctx) => { console.error(`[HUMAN INTERVENTION REQUIRED] ${ctx.error.message}`); }
        : undefined,
    });
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt < maxRetries) {
      try {
        await agent.prompt(task.description);
        lastError = null;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const failureCtx = failureHandler.createContext(
          'llm_error',
          lastError,
          stateMachine.getCurrentState(),
          attempt,
          { stagnationDetected },
        );
        const recovery = await failureHandler.handleFailure(failureCtx);
        if (!recovery.shouldRetry) break;
        attempt++;
        currentTemperature = Math.min(
          LLMConnector.DEFAULT_TEMPERATURE + attempt * LLMConnector.RETRY_TEMPERATURE_STEP,
          LLMConnector.MAX_TEMPERATURE,
        );
        stagnationDetector.reset();
        stateMachine.resetForRetry();
        safeModifier.clearAll();
      }
    }

    const finalState = stateMachine.getCurrentState();
    const agentMessages = agent.state.messages;
    const hadToolCalls = agentMessages.some((m) => m.role === 'toolResult');
    const success = (finalState === State.DONE || hadToolCalls || turnCount > 0) && lastError === null;

    const result: StateResult = {
      state: finalState,
      success,
      output: lastError ? `Failed: ${lastError.message}` : 'Task execution completed',
      toolCalls: [],
      nextState: State.DONE,
      messages: agentMessages,
    };

    task.result = result;
    task.state = success ? 'completed' : 'failed';
    return result;
  }
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasStateCompletionJson(state: State, text: string): boolean {
  const json = extractJson(text);
  if (!json) return false;
  switch (state) {
    case State.ANALYZE:
      return typeof json['summary'] === 'string' && Array.isArray(json['files']);
    case State.LOCATE:
      return Array.isArray(json['locations']);
    case State.MODIFY:
      return typeof json['edited'] === 'string';
    case State.VERIFY:
      return typeof json['passed'] === 'boolean';
    default:
      return false;
  }
}

function advanceState(current: State): State {
  const order = [State.ANALYZE, State.LOCATE, State.MODIFY, State.VERIFY, State.DONE];
  const idx = order.indexOf(current);
  return idx >= 0 && idx < order.length - 1 ? order[idx + 1]! : State.DONE;
}
