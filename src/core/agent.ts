import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentEvent } from '@mariozechner/pi-agent-core';
import { streamSimple } from '@mariozechner/pi-ai';
import type { Model } from '@mariozechner/pi-ai';
import { codingTools } from '@mariozechner/pi-coding-agent';
import { StateMachineAgent } from './session.js';
import { State, type StateResult } from './types.js';
import { TaskDecomposer } from './decomposer.js';
import { PromptBuilder } from '../provider/prompt.js';
import { StagnationDetector } from './cognitive/index.js';
import { FailureHandler } from './failure/handler.js';
import { LLMConnector } from '../provider/llm.js';
import { ContextCompactor } from './compaction/index.js';
import { astLocatorTool } from '../tool/locator.js';
import { SafeModifier, syntaxCheckHook, damageCheckHook } from '../tool/safety/index.js';
import { ConfigManager } from '../config/manager.js';

export type ExecutionEvent =
  | { type: 'state_change'; from: string; to: string }
  | { type: 'tool_call'; tool: string }
  | { type: 'llm_call'; promptLen: number; responseLen: number };

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
  private tasks: Task[];
  private currentTaskIndex: number;
  private decomposer: TaskDecomposer;

  constructor() {
    this.tasks = [];
    this.currentTaskIndex = 0;
    this.decomposer = new TaskDecomposer();
  }

  async decompose(taskDescription: string): Promise<Task[]> {
    const result = await this.decomposer.decompose(taskDescription);
    this.tasks = result.tasks.map((sub) => ({
      id: sub.id,
      description: sub.description,
      state: 'pending' as const,
    }));
    return this.tasks;
  }

  getTasks(): Task[] {
    return this.tasks;
  }

  async executeTask(
    task: Task,
    modelName: string,
    provider: string,
    baseUrl: string,
    onEvent?: (event: ExecutionEvent) => void,
  ): Promise<StateResult> {
    task.state = 'running';

    const stateMachine = new StateMachineAgent(modelName, [astLocatorTool]);
    const promptBuilder = new PromptBuilder();
    const model = buildModel(modelName, provider, baseUrl);
    const smConfig = ConfigManager.getInstance().getConfig().stateMachine;
    const stagnationDetector = new StagnationDetector();
    const contextCompactor = new ContextCompactor({
      maxTokens: smConfig.compactionThreshold > 0 ? smConfig.compactionThreshold * 8 : 24000,
      preserveFirstN: 2,
      preserveLastN: 6,
    });
    const safeModifier = new SafeModifier();
    const pendingModifyPaths = new Map<string, string>();
    let stagnationDetected = false;
    let currentTemperature = LLMConnector.DEFAULT_TEMPERATURE;
    let compactionSummary: string | null = null;

    const systemPrompt = promptBuilder.buildSystemPrompt({
      state: State.ANALYZE,
      task: task.description,
      modelParams: stateMachine.getModelParams(),
    });

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools: [...codingTools, astLocatorTool],
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
    const maxTurnsPerState = 5;
    const maxTotalTurns = 25;

    agent.subscribe((event: AgentEvent) => {
      if (event.type === 'tool_execution_start') {
        onEvent?.({ type: 'tool_call', tool: event.toolName });
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
        const filePath = pendingModifyPaths.get(event.toolCallId);
        pendingModifyPaths.delete(event.toolCallId);

        if (filePath && !event.isError && safeModifier.hasCheckpoint(filePath)) {
          const checkpoint = safeModifier.getCheckpoint(filePath);
          const originalContent = checkpoint?.originalContent ?? '';
          Promise.all([
            syntaxCheckHook.check(filePath, originalContent),
            damageCheckHook.check(filePath, originalContent),
          ]).then(([syntaxOk, damageOk]) => {
            if (!syntaxOk || !damageOk) {
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
        onEvent?.({ type: 'llm_call', promptLen: 0, responseLen: 0 });

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

        const shouldAdvance =
          stateMachine.getIteration() >= maxTurnsPerState || turnCount >= maxTotalTurns;

        if (shouldAdvance) {
          const nextState = advanceState(prevState);
          if (nextState !== prevState) {
            stateMachine.transitionTo(nextState);
            onEvent?.({ type: 'state_change', from: prevState, to: nextState });

            if (nextState !== State.DONE) {
              const newPrompt = promptBuilder.buildSystemPrompt({
                state: nextState,
                task: task.description,
                modelParams: stateMachine.getModelParams(),
              });
              agent.setSystemPrompt(newPrompt);

              agent.steer({
                role: 'user',
                content: [{ type: 'text', text: promptBuilder.buildUserPrompt(nextState, task.description) }],
                timestamp: Date.now(),
              });
            }
          }
        }
      }
    });

    const failureHandler = new FailureHandler({ maxRetries: stateMachine.getModelParams().maxRetries });
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= stateMachine.getModelParams().maxRetries) {
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
    };

    task.result = result;
    task.state = success ? 'completed' : 'failed';
    return result;
  }
}

function advanceState(current: State): State {
  const order = [State.ANALYZE, State.LOCATE, State.MODIFY, State.VERIFY, State.DONE];
  const idx = order.indexOf(current);
  return idx >= 0 && idx < order.length - 1 ? order[idx + 1]! : State.DONE;
}
