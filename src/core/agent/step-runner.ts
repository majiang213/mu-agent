import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';
import { StagnationDetector } from '../cognitive/index.js';
import { FailureHandler } from '../failure/handler.js';
import { LLMConnector } from '../../provider/llm.js';
import { CodeGraphLocator } from '../graph/locator.js';
import { buildCompleteTool } from '../../tool/complete.js';
import { ContextCompactor } from '../compaction/index.js';
import { buildSystemPrompt, buildUserPrompt } from '../prompts/index.js';
import { advanceState } from '../states.js';
import { buildStepAgent, subscribeStepEvents } from './step-agent.js';
import { State } from '../types.js';
import type { ExecutionEvent, Mission, RunConfig } from './types.js';
import type { Step, StepHandoff } from '../types.js';
import type { AgentEvent } from '@mariozechner/pi-agent-core';

export function buildModel(modelName: string, provider: string, baseUrl: string): Model<'openai-completions'> {
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

export function compressConversationHistory(
  messages: AgentMessage[],
  cfg?: { enableCompaction?: boolean; compactionThreshold?: number },
): AgentMessage[] {
  if (messages.length === 0) return [];
  if (cfg?.enableCompaction === false) return messages;
  const compactor = new ContextCompactor({ maxTokens: cfg?.compactionThreshold ?? 3000 });
  return compactor.compact(messages).messages;
}

export function parseReasonSteps(json: Record<string, unknown> | null): { steps: Step[]; error: string | null } {
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

export function DEFAULT_FALLBACK_STEPS(description: string): Step[] {
  return [
    { state: State.LOCATE, focus: `Find the exact files and lines to change for: ${description}` },
    { state: State.MODIFY, focus: `Apply the necessary code changes for: ${description}` },
    { state: State.VERIFY, focus: `Verify the changes are correct for: ${description}` },
  ];
}

export async function runStepAgent(
  agent: import('@mariozechner/pi-agent-core').Agent,
  input: string,
  cfg: RunConfig,
  stagnationDetector: StagnationDetector,
  isCompleted?: () => boolean,
): Promise<Error | null> {
  const maxRetries = Math.max(cfg.stateMachine.getModelParams().maxRetries, 3);
  const failureHandler = new FailureHandler({
    maxRetries,
    onHumanIntervention: (fCtx) => {
      console.error(`[HUMAN INTERVENTION REQUIRED] ${fCtx.error.message}`);
    },
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

export async function runReasonStep(
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

export async function runStep(
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
