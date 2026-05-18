import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import { streamSimple } from '@mariozechner/pi-ai';
import type { Model } from '@mariozechner/pi-ai';
import { codingTools } from '@mariozechner/pi-coding-agent';
import { StateMachineAgent } from './session.js';
import { State, type StateResult, type Step, type StepHandoff } from './types.js';
import { advanceState } from './states.js';
import { buildSystemPrompt, buildUserPrompt } from './prompts/index.js';
import type { EnvContext } from './prompts/agent.js';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { StagnationDetector } from './cognitive/index.js';
import { FailureHandler } from './failure/handler.js';
import { LLMConnector } from '../provider/llm.js';
import { astLocatorTool } from '../tool/locator.js';
import { SafeModifier, syntaxCheckHook, damageCheckHook } from '../tool/safety/index.js';
import { ConfigManager } from '../config/manager.js';
import { CodeGraphLocator } from './graph/locator.js';
import { buildCompleteTool } from '../tool/complete.js';
import { ContextCompactor } from './compaction/index.js';

export type ExecutionEvent =
  | { type: 'state_change'; from: string; to: string }
  | { type: 'tool_call'; tool: string; args?: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; isError: boolean }
  | { type: 'llm_output'; content: string }
  | { type: 'llm_thinking'; content: string }
  | { type: 'llm_output_delta'; content: string }
  | { type: 'llm_thinking_delta'; content: string }
  | { type: 'llm_call'; promptLen: number; responseLen: number; contextTokens: number }
  | { type: 'llm_prompt'; systemPrompt: string; userPrompt: string }
  | { type: 'task_start'; taskIndex: number; taskTotal: number; description: string }
  | { type: 'task_done'; taskIndex: number; taskTotal: number }
  | { type: 'clarification_needed'; questions: string[] };

interface Mission {
  id: string;
  description: string;
  state: 'pending' | 'running' | 'completed' | 'failed';
  result?: StateResult;
}

interface RunConfig {
  model: Model<'openai-completions'>;
  stateMachine: StateMachineAgent;
  safetyConfig: ReturnType<ConfigManager['getConfig']>['safety'];
  smConfig: ReturnType<ConfigManager['getConfig']>['stateMachine'];
  failureConfig: ReturnType<ConfigManager['getConfig']>['failureHandling'];
  safeModifier: SafeModifier;
  env: EnvContext;
  temperature: number;
  projectRoot: string;
  registerAgent?: (agent: Agent) => void;
  unregisterAgent?: (agent: Agent) => void;
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

function compressConversationHistory(
  messages: AgentMessage[],
  cfg?: { enableCompaction?: boolean; compactionThreshold?: number },
): AgentMessage[] {
  if (messages.length === 0) return [];
  if (cfg?.enableCompaction === false) return messages;
  const compactor = new ContextCompactor({ maxTokens: cfg?.compactionThreshold ?? 3000 });
  return compactor.compact(messages).messages;
}

function parseReasonSteps(json: Record<string, unknown> | null): { steps: Step[]; error: string | null } {
  if (!json) return { steps: [], error: 'complete() was not called or returned no data.' };
  if (!Array.isArray(json['steps']))
    return { steps: [], error: 'steps must be an array. Got: ' + JSON.stringify(json['steps']) };
  const validStates = new Set(Object.values(State));
  const invalid: string[] = [];
  const steps = (json['steps'] as unknown[]).filter((s): s is Step => {
    if (typeof s !== 'object' || s === null) {
      invalid.push(String(s));
      return false;
    }
    const r = s as Record<string, unknown>;
    if (typeof r['state'] !== 'string' || !validStates.has(r['state'] as State)) {
      invalid.push(`invalid state "${r['state']}"`);
      return false;
    }
    if (typeof r['focus'] !== 'string' || (r['focus'] as string).length === 0) {
      invalid.push(`missing focus for state "${r['state']}"`);
      return false;
    }
    return true;
  });
  if (steps.length === 0) {
    const reason = invalid.length > 0 ? `Invalid entries: ${invalid.join(', ')}` : 'steps array is empty.';
    return { steps: [], error: reason };
  }
  return { steps: steps.slice(0, 6), error: null };
}

function DEFAULT_FALLBACK_STEPS(description: string): Step[] {
  return [
    { state: State.LOCATE, focus: `Find the exact files and lines to change for: ${description}` },
    { state: State.MODIFY, focus: `Apply the necessary code changes for: ${description}` },
    { state: State.VERIFY, focus: `Verify the changes are correct for: ${description}` },
  ];
}

function buildStepAgent(
  systemPrompt: string,
  initialMessages: AgentMessage[],
  cfg: RunConfig,
  onEvent: ((event: ExecutionEvent) => void) | undefined,
  tools = [...codingTools, astLocatorTool],
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
      const lastUserMsg = [...agentCtx.messages].reverse().find((msg) => msg.role === 'user');
      const userPromptText =
        lastUserMsg && 'content' in lastUserMsg
          ? Array.isArray(lastUserMsg.content)
            ? (lastUserMsg.content as Array<{ type: string; text?: string }>)
                .filter((c) => c.type === 'text' && c.text)
                .map((c) => c.text as string)
                .join('\n')
            : typeof lastUserMsg.content === 'string'
              ? lastUserMsg.content
              : ''
          : '';
      if (!(opts as { signal?: AbortSignal })?.signal?.aborted) {
        onEvent?.({ type: 'llm_prompt', systemPrompt: agentCtx.systemPrompt ?? '', userPrompt: userPromptText });
      }
      return streamSimple(m, agentCtx, { ...opts, apiKey: 'ollama', temperature: cfg.temperature });
    },
    getApiKey: () => 'ollama',
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
        if (!cfg.stateMachine.canModifyMoreFiles(cfg.safetyConfig.maxFilesPerTask)) {
          return {
            block: true,
            reason: `File modification limit reached (max ${cfg.safetyConfig.maxFilesPerTask} files per task).`,
          };
        }
      }
      if ((toolName === 'edit' || toolName === 'write') && cfg.safetyConfig.enableCheckpoint) {
        const args = toolCtx.args as Record<string, unknown>;
        const filePath = typeof args['filePath'] === 'string' ? args['filePath'] : null;
        if (filePath) {
          try {
            await cfg.safeModifier.createCheckpoint(filePath);
          } catch (e) {
            void e;
          }
        }
      }
      return undefined;
    },
    afterToolCall: async (toolCtx) => {
      if (toolCtx.toolCall.name === 'complete' && !toolCtx.isError) {
        agentRef?.abort();
      }
      return undefined;
    },
    transformContext: async (messages) => {
      const steerIndices: number[] = [];
      messages.forEach((m, i) => {
        if (m.role === 'steer') steerIndices.push(i);
      });
      if (steerIndices.length <= 1) return messages;
      const latestSteer = steerIndices[steerIndices.length - 1]!;
      return messages.filter((m, i) => m.role !== 'steer' || i === latestSteer);
    },
    convertToLlm: (messages) => {
      return messages.flatMap((m) => {
        if (m.role === 'steer') {
          const sm = m as import('./types.js').SteerMessage;
          return [{ role: 'user' as const, content: sm.content, timestamp: sm.timestamp }];
        }
        return [m as import('@mariozechner/pi-ai').Message];
      });
    },
  });

  agentRef = agent;
  return agent;
}

function subscribeStepEvents(
  agent: Agent,
  state: State,
  stagnationDetector: StagnationDetector,
  cfg: RunConfig,
  onLlmText: (text: string) => void,
  onEvent?: (event: ExecutionEvent) => void,
): void {
  const pendingModifyPaths = new Map<string, string>();
  let stagnationWarnings = 0;
  let llmTurnCount = 0;
  const MAX_LLM_TURNS = 10;

  agent.subscribe((event: AgentEvent) => {
    if (event.type === 'tool_execution_start') {
      onEvent?.({ type: 'tool_call', tool: event.toolName, args: event.args as Record<string, unknown> });
      cfg.stateMachine.recordToolCall(event.toolName, event.args, null);
      stagnationDetector.recordToolCall({
        tool: event.toolName,
        input: event.args,
        output: null,
        timestamp: Date.now(),
      });
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
      if (event.isError) stagnationDetector.recordError(`tool_error:${event.toolName}`);
      if (
        filePath &&
        !event.isError &&
        cfg.safetyConfig.enableCheckpoint &&
        cfg.safetyConfig.enablePostCheck &&
        cfg.safeModifier.hasCheckpoint(filePath)
      ) {
        const checkpoint = cfg.safeModifier.getCheckpoint(filePath);
        const originalContent = checkpoint?.originalContent ?? '';
        Promise.all([
          syntaxCheckHook.check(filePath, originalContent),
          damageCheckHook.check(filePath, originalContent),
        ])
          .then(([syntaxOk, damageOk]) => {
            if (!syntaxOk || !damageOk) {
              stagnationDetector.recordError(`post_check_failed:${filePath}`);
              cfg.safeModifier
                .restore(filePath)
                .then(() => {
                  agent.steer({
                    role: 'steer',
                    content: `[SAFE MODIFIER] Post-check failed for ${filePath} (syntax=${syntaxOk}, damage=${damageOk}). File restored.`,
                    timestamp: Date.now(),
                  });
                })
                .catch(() => {});
            } else {
              cfg.safeModifier.clearCheckpoint(filePath);
            }
          })
          .catch(() => {});
      }
    }

    if (event.type === 'message_update') {
      const ae = (event as any).assistantMessageEvent as { type: string };
      const msg = (event as any).message as { content?: Array<{ type: string; text?: string; thinking?: string }> };
      if (msg?.content) {
        const parts = msg.content;
        if (ae.type === 'thinking_delta' || ae.type === 'thinking_start') {
          const thinking = parts
            .filter((c) => c.type === 'thinking' && c.thinking)
            .map((c) => c.thinking as string)
            .join('');
          if (thinking) onEvent?.({ type: 'llm_thinking_delta', content: thinking });
        }
        if (ae.type === 'text_delta' || ae.type === 'text_start') {
          const text = parts
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text as string)
            .join('')
            .replace(/<\/think>/g, '');
          if (text) onEvent?.({ type: 'llm_output_delta', content: text });
        }
      }
    }

    if (event.type === 'turn_end') {
      const msg = event.message;
      if (msg && 'content' in msg && Array.isArray(msg.content)) {
        const parts = msg.content as Array<{ type: string; text?: string; thinking?: string }>;
        const thinking = parts.filter((c) => c.type === 'thinking' && c.thinking).map((c) => c.thinking as string);
        const text = parts.filter((c) => c.type === 'text' && c.text).map((c) => c.text as string);
        if (thinking.length > 0) onEvent?.({ type: 'llm_thinking', content: thinking.join('\n') });
        if (text.length > 0) {
          const joined = text
            .join('\n')
            .replace(/<\/think>/g, '')
            .trim();
          if (joined) {
            onEvent?.({ type: 'llm_output', content: joined });
            onLlmText(joined);
          }
        }
      }
      const usage = msg && 'usage' in msg ? (msg as { usage?: { input?: number; output?: number } }).usage : null;
      const inputTokens = usage?.input ?? 0;
      onEvent?.({
        type: 'llm_call',
        promptLen: inputTokens,
        responseLen: usage?.output ?? 0,
        contextTokens: inputTokens,
      });

      llmTurnCount++;
      if (llmTurnCount >= MAX_LLM_TURNS) {
        agent.abort();
        return;
      }

      if (cfg.smConfig.enableStagnationDetector) {
        const stagnationResult = stagnationDetector.check();
        if (stagnationResult?.detected) {
          if (stagnationWarnings >= 1) {
            agent.abort();
          } else {
            stagnationWarnings++;
            stagnationDetector.reset();
            agent.steer({
              role: 'steer',
              content: `[STAGNATION DETECTED] ${stagnationResult.message}. ${stagnationResult.suggestion}.`,
              timestamp: Date.now(),
            });
          }
        }
      }
    }
  });
}

async function runStepAgent(
  agent: Agent,
  input: string,
  cfg: RunConfig,
  stagnationDetector: StagnationDetector,
  isCompleted?: () => boolean,
): Promise<Error | null> {
  const maxRetries = Math.max(cfg.stateMachine.getModelParams().maxRetries, cfg.failureConfig.maxRetries);
  const failureHandler = new FailureHandler({
    maxRetries,
    onHumanIntervention: cfg.failureConfig.enableHumanIntervention
      ? (fCtx) => {
          console.error(`[HUMAN INTERVENTION REQUIRED] ${fCtx.error.message}`);
        }
      : undefined,
  });
  let attempt = 0;
  let lastError: Error | null = null;
  while (attempt < maxRetries) {
    try {
      await agent.prompt(input);
      lastError = null;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isAbort = lastError.name === 'AbortError' || lastError.message.includes('aborted');
      if (isAbort) {
        if (isCompleted?.()) {
          lastError = null;
        }
        break;
      }
      const failureCtx = failureHandler.createContext(
        'llm_error',
        lastError,
        cfg.stateMachine.getCurrentState(),
        attempt,
        {},
      );
      const recovery = await failureHandler.handleFailure(failureCtx);
      if (recovery.action === 'abort') break;
      cfg.temperature = Math.min(
        LLMConnector.DEFAULT_TEMPERATURE + attempt * LLMConnector.RETRY_TEMPERATURE_STEP,
        LLMConnector.MAX_TEMPERATURE,
      );
      stagnationDetector.reset();
      cfg.stateMachine.resetForRetry();
      cfg.safeModifier.clearAll();
    }
    attempt++;
  }
  return lastError;
}

async function runReasonStep(
  mission: Mission,
  cfg: RunConfig,
  conversationHistory: AgentMessage[],
  onEvent?: (event: ExecutionEvent) => void,
): Promise<{ steps: Step[]; needsClarify: boolean; questions: string[] }> {
  cfg.stateMachine.transitionTo(State.REASON);
  const systemPrompt = buildSystemPrompt({
    state: State.REASON,
    task: mission.description,
    modelParams: cfg.stateMachine.getModelParams(),
    env: cfg.env,
  });

  const stagnationDetector = new StagnationDetector();
  let capturedComplete: Record<string, unknown> | null = null;
  const completeTool = buildCompleteTool(State.REASON, (args) => {
    capturedComplete = args;
  });

  const agent = buildStepAgent(systemPrompt, conversationHistory, cfg, onEvent, [completeTool]);
  subscribeStepEvents(agent, State.REASON, stagnationDetector, cfg, () => {}, onEvent);

  cfg.registerAgent?.(agent);
  try {
    onEvent?.({ type: 'state_change', from: 'IDLE', to: State.REASON });
    await runStepAgent(agent, mission.description, cfg, stagnationDetector, () => capturedComplete !== null);

    if (capturedComplete === null) {
      agent.steer({
        role: 'steer',
        content: '[REMINDER] You must call complete() to submit your execution plan.',
        timestamp: Date.now(),
      });
      await runStepAgent(agent, '', cfg, stagnationDetector, () => capturedComplete !== null);
    }
  } finally {
    cfg.unregisterAgent?.(agent);
  }

  if (capturedComplete !== null) {
    const c = capturedComplete;
    if (c['needsClarify'] === true) {
      const questions = Array.isArray(c['questions']) ? (c['questions'] as string[]) : [];
      return { steps: [], needsClarify: true, questions };
    }
    const { steps, error } = parseReasonSteps(c);
    if (steps.length > 0) {
      return { steps, needsClarify: false, questions: [] };
    }
    capturedComplete = null;
    agent.steer({
      role: 'steer',
      content: `[ERROR] complete() was called but the plan is invalid. ${error} Fix and call complete() again with valid steps.`,
      timestamp: Date.now(),
    });
    await runStepAgent(agent, '', cfg, stagnationDetector, () => capturedComplete !== null);
    if (capturedComplete !== null) {
      const { steps: retrySteps } = parseReasonSteps(capturedComplete);
      if (retrySteps.length > 0) {
        return { steps: retrySteps, needsClarify: false, questions: [] };
      }
    }
  } else {
    agent.steer({
      role: 'steer',
      content: '[ERROR] You did not call complete(). You MUST call complete(steps=[...]) now to submit your plan.',
      timestamp: Date.now(),
    });
    await runStepAgent(agent, '', cfg, stagnationDetector, () => capturedComplete !== null);
    if (capturedComplete !== null) {
      const { steps } = parseReasonSteps(capturedComplete);
      if (steps.length > 0) {
        return { steps, needsClarify: false, questions: [] };
      }
    }
  }

  return { steps: DEFAULT_FALLBACK_STEPS(mission.description), needsClarify: false, questions: [] };
}

async function runStep(
  step: Step,
  stepIndex: number,
  stepTotal: number,
  mission: Mission,
  stepResults: StepHandoff[],
  cfg: RunConfig,
  onEvent?: (event: ExecutionEvent) => void,
): Promise<StepHandoff> {
  const trajectory = [step.state, State.DONE];
  cfg.stateMachine.resetForNextTask(step.state);

  const STATES_NEEDING_LOCATE = new Set([
    State.LOCATE,
    State.RESEARCH,
    State.DIAGNOSE,
    State.REVIEW,
    State.REFACTOR_PLAN,
  ]);

  let stepEnv = cfg.env;
  if (STATES_NEEDING_LOCATE.has(step.state)) {
    try {
      const locator = new CodeGraphLocator(cfg.projectRoot);
      const result = locator.locate(step.focus);
      stepEnv = {
        ...cfg.env,
        projectTree: result.tree,
        suggestedFiles: result.suggestedFiles,
      };
    } catch (e) {
      void e;
    }
  }

  const systemPrompt = buildSystemPrompt({
    state: step.state,
    task: mission.description,
    focus: step.focus,
    modelParams: cfg.stateMachine.getModelParams(),
    env: stepEnv,
  });

  const allowedTools = cfg.stateMachine.getAllowedTools().filter((t) => t.name !== 'complete');
  const READ_ONLY_STATES = new Set([State.RESEARCH, State.REVIEW, State.DIAGNOSE, State.REFACTOR_PLAN]);
  const stagnationDetector = new StagnationDetector({
    checkNoProgress: !READ_ONLY_STATES.has(step.state),
  });
  let llmText = '';
  let capturedComplete: Record<string, unknown> | null = null;

  const completeTool = buildCompleteTool(step.state, (args) => {
    capturedComplete = args;
  });
  const readFiles = new Set<string>();
  const agent = buildStepAgent(systemPrompt, [], cfg, onEvent, [...allowedTools, completeTool], readFiles);

  subscribeStepEvents(
    agent,
    step.state,
    stagnationDetector,
    cfg,
    (text) => {
      llmText = text;
    },
    onEvent,
  );

  agent.subscribe((event: AgentEvent) => {
    if (event.type === 'turn_end' && capturedComplete !== null) {
      const nextState = advanceState(step.state, trajectory);
      if (nextState !== step.state) {
        cfg.stateMachine.transitionTo(nextState);
        onEvent?.({ type: 'state_change', from: step.state, to: nextState });
      }
    }
  });

  onEvent?.({ type: 'task_start', taskIndex: stepIndex, taskTotal: stepTotal, description: step.focus });
  onEvent?.({ type: 'state_change', from: State.REASON, to: step.state });

  const input = buildUserPrompt(step.state, mission.description, step.focus);
  cfg.registerAgent?.(agent);
  try {
    await runStepAgent(agent, input, cfg, stagnationDetector, () => capturedComplete !== null);

    if (capturedComplete === null) {
      agent.steer({
        role: 'steer',
        content:
          '[REMINDER] You finished your work but did not call complete(). Call complete() now with your findings.',
        timestamp: Date.now(),
      });
      await runStepAgent(agent, '', cfg, stagnationDetector, () => capturedComplete !== null);
    }
  } finally {
    cfg.unregisterAgent?.(agent);
  }

  onEvent?.({ type: 'task_done', taskIndex: stepIndex, taskTotal: stepTotal });

  if (step.state === State.MODIFY && capturedComplete !== null) {
    try {
      const edited = Array.isArray(capturedComplete['edited']) ? (capturedComplete['edited'] as string[]) : [];
      if (edited.length > 0) {
        const locator = new CodeGraphLocator(cfg.projectRoot);
        const absPaths = edited.map((f) => (f.startsWith('/') ? f : `${cfg.projectRoot}/${f}`));
        locator.updateFiles(absPaths);
      }
    } catch (e) {
      void e;
    }
  }

  const output = capturedComplete !== null ? JSON.stringify(capturedComplete) : llmText;
  return { state: step.state, focus: step.focus, output };
}

export class ReactAgent {
  private _pendingClarification: ((answer: string) => void) | null = null;
  private _activeAgents: Set<Agent> = new Set();

  abort(): void {
    for (const agent of this._activeAgents) {
      agent.abort();
    }
    this._activeAgents.clear();
  }

  provideClarification(answer: string): void {
    if (this._pendingClarification) {
      this._pendingClarification(answer);
      this._pendingClarification = null;
    }
  }

  async run(
    input: string,
    modelName: string,
    provider: string,
    baseUrl: string,
    onEvent?: (event: ExecutionEvent) => void,
    initialMessages?: AgentMessage[],
  ): Promise<StateResult> {
    const mission: Mission = {
      id: `task-${Date.now()}`,
      description: input,
      state: 'running',
    };

    const stateMachine = new StateMachineAgent(modelName, [astLocatorTool]);
    const model = buildModel(modelName, provider, baseUrl);
    const agentConfig = ConfigManager.getInstance().getConfig();

    const cwd = process.cwd();
    const home = homedir();
    const cwdDisplay = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
    let isGitRepo: boolean;
    try {
      execSync('git rev-parse --git-dir', { stdio: 'ignore' });
      isGitRepo = true;
    } catch {
      isGitRepo = false;
    }

    const env: EnvContext = {
      cwd: cwdDisplay,
      platform: process.platform,
      isGitRepo,
      date: new Date().toDateString(),
    };

    const cfg: RunConfig = {
      model,
      stateMachine,
      safetyConfig: agentConfig.safety,
      smConfig: agentConfig.stateMachine,
      failureConfig: agentConfig.failureHandling,
      safeModifier: new SafeModifier(agentConfig.system.task.checkpointDir),
      env,
      temperature: LLMConnector.DEFAULT_TEMPERATURE,
      projectRoot: cwd,
      registerAgent: (a) => this._activeAgents.add(a),
      unregisterAgent: (a) => this._activeAgents.delete(a),
    };

    const conversationHistory = compressConversationHistory(initialMessages ?? [], cfg.smConfig);

    const { steps, needsClarify, questions } = await runReasonStep(mission, cfg, conversationHistory, onEvent);

    if (needsClarify) {
      onEvent?.({ type: 'clarification_needed', questions });
      return {
        state: State.DONE,
        success: true,
        output: 'Clarification needed',
        toolCalls: [],
        nextState: State.DONE,
        messages: [],
      };
    }

    const stepResults: StepHandoff[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const handoff = await runStep(step, i, steps.length, mission, stepResults, cfg, onEvent);
      stepResults.push(handoff);
    }

    mission.state = 'completed';
    return {
      state: State.DONE,
      success: true,
      output: stepResults[stepResults.length - 1]?.output ?? 'Task completed',
      toolCalls: [],
      nextState: State.DONE,
      messages: [],
    };
  }
}
