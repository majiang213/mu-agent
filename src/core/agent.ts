import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import { streamSimple } from '@mariozechner/pi-ai';
import type { Model } from '@mariozechner/pi-ai';
import { codingTools } from '@mariozechner/pi-coding-agent';
import { StateMachineAgent } from './session.js';
import { State, type StateResult } from './types.js';
import { hasStateCompletionJson, advanceState } from './states.js';
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

interface Task {
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

interface ExecCtx {
  compactionSummary: string | null;
  currentTemperature: number;
  stagnationDetected: boolean;
  turnCount: number;
}

function buildAgentConfig(
  task: Task,
  model: Model<'openai-completions'>,
  stateMachine: StateMachineAgent,
  safetyConfig: ReturnType<ConfigManager['getConfig']>['safety'],
  safeModifier: SafeModifier,
  ctx: ExecCtx,
  initialMessages?: AgentMessage[],
): ConstructorParameters<typeof Agent>[0] {
  const systemPrompt = buildSystemPrompt({
    state: State.ANALYZE,
    task: task.description,
    modelParams: stateMachine.getModelParams(),
  });

  return {
    initialState: {
      systemPrompt,
      model,
      tools: [...codingTools, astLocatorTool],
      ...(initialMessages && initialMessages.length > 0 ? { messages: initialMessages } : {}),
    },
    streamFn: async (m, agentCtx, opts) => {
      if (ctx.compactionSummary !== null) {
        const summary = ctx.compactionSummary;
        ctx.compactionSummary = null;
        const preserved = agentCtx.messages.slice(-6);
        const summaryMsg = { role: 'user' as const, content: `[Earlier context summarized]: ${summary}`, timestamp: Date.now() };
        const compactedCtx = { ...agentCtx, messages: [summaryMsg, ...preserved] };
        return streamSimple(m, compactedCtx, { ...opts, apiKey: 'ollama', temperature: ctx.currentTemperature });
      }
      return streamSimple(m, agentCtx, { ...opts, apiKey: 'ollama', temperature: ctx.currentTemperature });
    },
    getApiKey: () => 'ollama',
    beforeToolCall: async (toolCtx) => {
      const allowedTools = stateMachine.getAllowedTools().map((t) => t.name);
      const toolName = toolCtx.toolCall.name;
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
        const args = toolCtx.args as Record<string, unknown>;
        const filePath = typeof args['filePath'] === 'string' ? args['filePath'] : null;
        if (filePath) {
          try {
            await safeModifier.createCheckpoint(filePath);
          } catch { /* new file — no checkpoint needed */ }
        }
      }
      return undefined;
    },
  };
}

function subscribeAgentEvents(
  agent: Agent,
  task: Task,
  stateMachine: StateMachineAgent,
  stagnationDetector: StagnationDetector,
  contextCompactor: ContextCompactor,
  safeModifier: SafeModifier,
  safetyConfig: ReturnType<ConfigManager['getConfig']>['safety'],
  smConfig: ReturnType<ConfigManager['getConfig']>['stateMachine'],
  ctx: ExecCtx,
  onEvent?: (event: ExecutionEvent) => void,
): void {
  const pendingModifyPaths = new Map<string, string>();

  agent.subscribe((event: AgentEvent) => {
    if (event.type === 'tool_execution_start') {
      onEvent?.({ type: 'tool_call', tool: event.toolName, args: event.args as Record<string, unknown> });
      stateMachine.recordToolCall(event.toolName, event.args, null);
      stagnationDetector.recordToolCall({ tool: event.toolName, input: event.args, output: null, timestamp: Date.now() });
      if (event.toolName === 'edit' || event.toolName === 'write') {
        const args = event.args as Record<string, unknown>;
        const fp = typeof args['filePath'] === 'string' ? args['filePath'] : null;
        if (fp) pendingModifyPaths.set(event.toolCallId, fp);
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
        Promise.all([syntaxCheckHook.check(filePath, originalContent), damageCheckHook.check(filePath, originalContent)])
          .then(([syntaxOk, damageOk]) => {
            if (!syntaxOk || !damageOk) {
              stagnationDetector.recordError(`post_check_failed:${filePath}(syntax=${syntaxOk},damage=${damageOk})`);
              safeModifier.restore(filePath).then(() => {
                agent.steer({
                  role: 'user',
                  content: [{ type: 'text', text: `[SAFE MODIFIER] Post-check failed for ${filePath} (syntax=${syntaxOk}, damage=${damageOk}). File restored. Please try a more conservative edit.` }],
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
      ctx.turnCount++;
      const msg = event.message;
      if (msg && 'content' in msg && Array.isArray(msg.content)) {
        const parts = msg.content as Array<{ type: string; text?: string; thinking?: string }>;
        const thinking = parts.filter((c) => c.type === 'thinking' && c.thinking).map((c) => c.thinking as string);
        const text = parts.filter((c) => c.type === 'text' && c.text).map((c) => c.text as string);
        if (thinking.length > 0) onEvent?.({ type: 'llm_thinking', content: thinking.join('\n') });
        if (text.length > 0) onEvent?.({ type: 'llm_output', content: text.join('\n') });
      }
      const usage = msg && 'usage' in msg ? (msg as { usage?: { input?: number; output?: number } }).usage : null;
      const inputTokens = usage?.input ?? 0;
      onEvent?.({ type: 'llm_call', promptLen: inputTokens, responseLen: usage?.output ?? 0, contextTokens: inputTokens });

      const stagnationResult = smConfig.enableStagnationDetector ? stagnationDetector.check() : null;
      if (stagnationResult?.detected) {
        ctx.stagnationDetected = true;
        agent.steer({
          role: 'user',
          content: [{ type: 'text', text: `[STAGNATION DETECTED] ${stagnationResult.message}. ${stagnationResult.suggestion}. Stopping current approach.` }],
          timestamp: Date.now(),
        });
        const currentState = stateMachine.getCurrentState();
        const escapeState = currentState === State.MODIFY || currentState === State.LOCATE ? State.VERIFY : State.DONE;
        if (escapeState !== currentState) {
          stateMachine.transitionTo(escapeState);
          onEvent?.({ type: 'state_change', from: currentState, to: escapeState });
        }
        return;
      }

      if (smConfig.enableCompaction) {
        const rawMessages = agent.state.messages.map((m) => {
          const content = 'content' in m ? (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) : '';
          return { role: m.role, content };
        });
        const compactionResult = contextCompactor.compact(rawMessages);
        if (compactionResult.compacted && compactionResult.summary) {
          ctx.compactionSummary = compactionResult.summary;
        }
      }

      const prevState = stateMachine.getCurrentState();
      if (prevState === State.DONE) return;
      stateMachine.incrementIteration();

      const llmText = msg && 'content' in msg && Array.isArray(msg.content)
        ? (msg.content as Array<{ type: string; text?: string }>).filter((c) => c.type === 'text' && c.text).map((c) => c.text as string).join('\n')
        : '';

      if (hasStateCompletionJson(prevState, llmText)) {
        const nextState = advanceState(prevState);
        if (nextState !== prevState) {
          stateMachine.transitionTo(nextState);
          onEvent?.({ type: 'state_change', from: prevState, to: nextState });
          if (nextState !== State.DONE) {
            agent.setSystemPrompt(buildSystemPrompt({ state: nextState, task: task.description, modelParams: stateMachine.getModelParams() }));
            agent.steer({ role: 'user', content: [{ type: 'text', text: buildUserPrompt(nextState, task.description) }], timestamp: Date.now() });
          }
        }
      }
    }
  });
}

async function runAgentWithRetry(
  agent: Agent,
  task: Task,
  stateMachine: StateMachineAgent,
  stagnationDetector: StagnationDetector,
  safeModifier: SafeModifier,
  failureConfig: ReturnType<ConfigManager['getConfig']>['failureHandling'],
  ctx: ExecCtx,
): Promise<Error | null> {
  const maxRetries = Math.max(stateMachine.getModelParams().maxRetries, failureConfig.maxRetries);
  const failureHandler = new FailureHandler({
    maxRetries,
    onHumanIntervention: failureConfig.enableHumanIntervention
      ? (fCtx) => { console.error(`[HUMAN INTERVENTION REQUIRED] ${fCtx.error.message}`); }
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
      const failureCtx = failureHandler.createContext('llm_error', lastError, stateMachine.getCurrentState(), attempt, { stagnationDetected: ctx.stagnationDetected });
      const recovery = await failureHandler.handleFailure(failureCtx);
      if (!recovery.shouldRetry) break;
      attempt++;
      ctx.currentTemperature = Math.min(
        LLMConnector.DEFAULT_TEMPERATURE + attempt * LLMConnector.RETRY_TEMPERATURE_STEP,
        LLMConnector.MAX_TEMPERATURE,
      );
      stagnationDetector.reset();
      stateMachine.resetForRetry();
      safeModifier.clearAll();
    }
  }
  return lastError;
}

export class ReactAgent {
  async run(
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
      state: 'running',
    };

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
    const ctx: ExecCtx = { compactionSummary: null, currentTemperature: LLMConnector.DEFAULT_TEMPERATURE, stagnationDetected: false, turnCount: 0 };

    const agent = new Agent(buildAgentConfig(task, model, stateMachine, safetyConfig, safeModifier, ctx, initialMessages));
    subscribeAgentEvents(agent, task, stateMachine, stagnationDetector, contextCompactor, safeModifier, safetyConfig, smConfig, ctx, onEvent);

    const lastError = await runAgentWithRetry(agent, task, stateMachine, stagnationDetector, safeModifier, failureConfig, ctx);

    const finalState = stateMachine.getCurrentState();
    const agentMessages = agent.state.messages;
    const hadToolCalls = agentMessages.some((m) => m.role === 'toolResult');
    const success = (finalState === State.DONE || hadToolCalls || ctx.turnCount > 0) && lastError === null;

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


