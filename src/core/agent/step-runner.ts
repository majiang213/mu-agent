import type { AgentMessage, AgentTool } from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';
import { StagnationDetector } from '../cognitive/index.js';
import { SafeModifier } from '../../tool/safety/checkpoint.js';
import { FailureHandler } from '../failure/handler.js';
import {
  DEFAULT_TEMPERATURE,
  MAX_TEMPERATURE,
  RETRY_TEMPERATURE_STEP,
  DEFAULT_CONTEXT_RATIO,
} from '../../config/defaults.js';
import { fetchContextLength } from '../../provider/model-info.js';
import { CodeGraphLocator } from '../graph/locator.js';
import { buildCompleteTool } from '../../tool/complete.js';
import { ContextCompactor, compressConversationHistoryWithLLM } from '../compaction/index.js';
import { buildSystemPrompt, buildUserPrompt } from '../prompts/index.js';
import { advanceState } from '../states.js';
import { buildStepAgent, subscribeStepEvents } from './builder.js';
import { samplePlans, deliberate, pickShortest, SAMPLING_BATCH_SIZE } from '../heavy/index.js';
import { State } from '../types.js';
import type { ExecutionEvent, Mission, RunConfig } from './types.js';
import type { Step, ExecutedStep, StepDirective } from '../types.js';

const MEMORY_STATES = new Set([State.REASON, State.ANSWER, State.RESEARCH, State.DIAGNOSE]);

const REMINDER_FIELDS: Partial<Record<State, string>> = {
  [State.ANSWER]: 'answer (string)',
  [State.RESEARCH]: 'report (string)',
  [State.VERIFY]: 'passed (boolean), issues (array), summary (string)',
  [State.LOCATE]: 'locations (array of {file, startLine, endLine, snippet})',
  [State.MODIFY]: 'edited (array of file paths), linesChanged (number)',
  [State.DIAGNOSE]: 'rootCause (string), location (string), fix (string)',
  [State.REVIEW]: 'issues (array), suggestions (array), verdict ("pass"|"fail")',
  [State.ROLLBACK]: 'restored (array of file paths)',
  [State.RUN]: 'exitCode (number), summary (string)',
  [State.TEST_WRITE]: 'testFile (string), cases (number)',
  [State.REFACTOR_PLAN]: 'refactorSteps (array of strings), estimatedFiles (number)',
};

export async function buildModel(
  modelName: string,
  provider: string,
  baseUrl: string,
  contextRatio: number,
  apiKey?: string,
): Promise<Model<'openai-completions'>> {
  const apiBase = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
  const contextWindow = await fetchContextLength(provider, baseUrl, modelName, apiKey);
  return {
    id: modelName,
    name: modelName,
    api: 'openai-completions',
    provider,
    baseUrl: apiBase,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.floor(contextWindow * (1 - contextRatio)),
  };
}

export function compressConversationHistorySync(
  messages: AgentMessage[],
  cfg?: { enableCompaction?: boolean; compactionThreshold?: number },
): AgentMessage[] {
  if (messages.length === 0) return [];
  if (cfg?.enableCompaction === false) return messages;
  const compactor = new ContextCompactor({ maxTokens: cfg?.compactionThreshold ?? 3000 });
  return compactor.compact(messages).messages;
}

export async function compressConversationHistory(
  messages: AgentMessage[],
  model: Model<'openai-completions'>,
  contextRatio = DEFAULT_CONTEXT_RATIO,
  apiKey = 'ollama',
): Promise<AgentMessage[]> {
  if (messages.length === 0) return [];
  return compressConversationHistoryWithLLM(messages, model, contextRatio, apiKey);
}

function isValidStep(s: unknown, validStates: Set<string>, invalid: string[]): s is Step {
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
}

export function parseReasonSteps(json: Record<string, unknown> | null): {
  steps: StepDirective[];
  error: string | null;
} {
  if (!json) return { steps: [], error: 'complete() was not called or returned no data.' };
  if (!Array.isArray(json['steps']))
    return { steps: [], error: 'steps must be an array. Got: ' + JSON.stringify(json['steps']) };
  const validStates = new Set(Object.values(State));
  const invalid: string[] = [];
  const directives: StepDirective[] = [];

  for (const item of json['steps'] as unknown[]) {
    if (typeof item !== 'object' || item === null) {
      invalid.push(String(item));
      continue;
    }
    const r = item as Record<string, unknown>;

    if (Array.isArray(r['parallel'])) {
      const parallelSteps: Step[] = [];
      for (const ps of r['parallel'] as unknown[]) {
        if (isValidStep(ps, validStates, invalid)) {
          parallelSteps.push(ps);
        }
      }
      if (parallelSteps.length > 0) {
        directives.push({ parallel: parallelSteps });
      }
    } else if (isValidStep(item, validStates, invalid)) {
      directives.push(item);
    }
  }

  if (directives.length === 0 && invalid.length > 0) {
    return { steps: [], error: `Invalid entries: ${invalid.join(', ')}` };
  }
  // Cap at 6 directives (not flattened steps): a { parallel: [...] } counts as one directive.
  // This intentionally allows a parallel group with many inner steps to exceed 6 total steps.
  return { steps: directives.slice(0, 6), error: null };
}

export async function runStepAgent(
  agent: import('@mariozechner/pi-agent-core').Agent,
  input: string,
  cfg: RunConfig,
  stagnationDetector: StagnationDetector,
  _isCompleted?: () => boolean,
): Promise<void> {
  const maxRetries = Math.max(cfg.stateMachine.getModelParams().maxRetries, 3);
  const failureHandler = new FailureHandler({
    maxRetries,
    onHumanIntervention: (fCtx) => {
      console.error(`[HUMAN INTERVENTION REQUIRED] ${fCtx.error.message}`);
    },
  });
  let attempt = 0;
  let lastError: Error | undefined;
  while (attempt < maxRetries) {
    try {
      await agent.prompt(input);
      return;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;
      const isAbort = error.name === 'AbortError' || error.message.includes('aborted');
      if (isAbort) {
        return;
      }
      const failureCtx = failureHandler.createContext(
        'llm_error',
        error,
        cfg.stateMachine.getCurrentState(),
        attempt,
        {},
      );
      const recovery = await failureHandler.handleFailure(failureCtx);
      if (recovery.action === 'abort') return;
      cfg.temperature = Math.min(DEFAULT_TEMPERATURE + attempt * RETRY_TEMPERATURE_STEP, MAX_TEMPERATURE);
      stagnationDetector.reset();
      cfg.stateMachine.resetForRetry();
      cfg.safeModifier.clearAll();
    }
    attempt++;
  }
  throw lastError ?? new Error('runStepAgent: max retries exhausted');
}

export async function runReasonStep(
  mission: Mission,
  cfg: RunConfig,
  conversationHistory: AgentMessage[],
  onEvent?: (event: ExecutionEvent) => void,
  onNeedsClarify?: (questions: string[]) => Promise<string>,
  memoryIndex?: string,
  memorySearchTool?: AgentTool<any, any>,
): Promise<{ steps: StepDirective[] }> {
  const htCfg = cfg.heavyThinking;
  const tier = cfg.stateMachine.getModelParams().tier;
  const heavyEnabled = tier === 'SMALL' || tier === 'MEDIUM';

  if (!heavyEnabled) {
    return runSingleReasonAttempt(
      mission,
      cfg,
      conversationHistory,
      onEvent,
      onNeedsClarify,
      'IDLE',
      memoryIndex,
      memorySearchTool,
    );
  }

  onEvent?.({ type: 'state_change', from: 'IDLE', to: State.REASON });

  const phase0OnEvent = onEvent
    ? (event: ExecutionEvent) => {
        if (event.type === 'state_change') return;
        onEvent(event);
      }
    : undefined;

  let phase0Candidate: import('../heavy/types.js').PlanCandidate | null = null;
  try {
    const phase0Result = await runSingleReasonAttempt(
      mission,
      cfg,
      conversationHistory,
      phase0OnEvent,
      undefined,
      'IDLE',
      memoryIndex,
      memorySearchTool,
    );
    const flatSteps = phase0Result.steps.flatMap((d) => ('parallel' in d ? d.parallel : [d]));
    if (flatSteps.length <= 1) {
      return phase0Result;
    }
    onEvent?.({ type: 'state_change', from: State.REASON, to: 'SAMPLING' });
    onEvent?.({ type: 'deliberation_start', candidateCount: SAMPLING_BATCH_SIZE + 1 });
    onEvent?.({ type: 'sample_start', index: 0, total: SAMPLING_BATCH_SIZE + 1 });
    onEvent?.({ type: 'sample_complete', index: 0, steps: flatSteps });
    phase0Candidate = { id: 'plan-phase0', steps: flatSteps, sampledAt: Date.now() };
  } catch (_) {
    void _;
    onEvent?.({ type: 'state_change', from: State.REASON, to: 'SAMPLING' });
    onEvent?.({ type: 'deliberation_start', candidateCount: SAMPLING_BATCH_SIZE });
    onEvent?.({ type: 'sample_failed', index: 0 });
  }

  let currentMission = mission;
  let candidates = await samplePlans(
    currentMission,
    cfg,
    conversationHistory,
    { samplingTemperature: htCfg?.samplingTemperature },
    onEvent,
    phase0Candidate ? [phase0Candidate] : [],
    1,
  );

  if (candidates.length === 0) {
    onEvent?.({ type: 'deliberation_fallback', reason: '所有采样失败，回退到单次规划' });
    return runSingleReasonAttempt(
      mission,
      cfg,
      conversationHistory,
      onEvent,
      onNeedsClarify,
      'IDLE',
      memoryIndex,
      memorySearchTool,
    );
  }

  let outcome = await deliberate(candidates, currentMission, cfg, onEvent);

  if (outcome.type === 'needs_clarification') {
    onEvent?.({ type: 'deliberation_clarification', question: outcome.question });
    const answer = onNeedsClarify ? await onNeedsClarify([outcome.question]) : null;

    if (!answer) {
      return { steps: pickShortest(candidates).steps };
    }

    currentMission = {
      ...mission,
      description: `${mission.description}\n\nAdditional context: ${answer}`,
    };
    candidates = await samplePlans(currentMission, cfg, conversationHistory, {
      samplingTemperature: htCfg?.samplingTemperature,
    });
    if (candidates.length === 0) {
      onEvent?.({
        type: 'deliberation_fallback',
        reason: 'all samples failed after clarification, falling back to single attempt',
      });
      return runSingleReasonAttempt(
        currentMission,
        cfg,
        conversationHistory,
        onEvent,
        undefined,
        State.REASON,
        memoryIndex,
        memorySearchTool,
      );
    }

    outcome = await deliberate(candidates, currentMission, cfg, onEvent, false);
  }

  if (outcome.type === 'selected') {
    const { result } = outcome;
    onEvent?.({
      type: 'deliberation_complete',
      synthesizedStepCount: result.synthesizedSteps.length,
      summary: result.deliberationSummary,
    });
    return { steps: result.synthesizedSteps };
  }

  const fallback = pickShortest(candidates);
  return { steps: fallback.steps };
}

async function runSingleReasonAttempt(
  mission: Mission,
  cfg: RunConfig,
  conversationHistory: AgentMessage[],
  onEvent?: (event: ExecutionEvent) => void,
  onNeedsClarify?: (questions: string[]) => Promise<string>,
  fromState: State | 'IDLE' = 'IDLE',
  memoryIndex?: string,
  memorySearchTool?: AgentTool<any, any>,
): Promise<{ steps: StepDirective[] }> {
  cfg.stateMachine.transitionTo(State.REASON);
  const systemPrompt = buildSystemPrompt({
    state: State.REASON,
    task: mission.description,
    modelParams: cfg.stateMachine.getModelParams(),
    env: cfg.env,
    memoryIndex,
  });

  const stagnationDetector = new StagnationDetector();
  let capturedComplete: Record<string, unknown> | null = null;
  const completeTool = buildCompleteTool(State.REASON, (args) => {
    capturedComplete = args;
  });

  const extraTools: AgentTool<any, any>[] = memorySearchTool ? [memorySearchTool] : [];
  const reasonCfg: typeof cfg = cfg;
  const agent = buildStepAgent(systemPrompt, conversationHistory, reasonCfg, onEvent, [completeTool, ...extraTools]);
  subscribeStepEvents(agent, State.REASON, stagnationDetector, cfg, () => {}, onEvent);

  cfg.registerAgent?.(agent);
  try {
    onEvent?.({ type: 'state_change', from: fromState, to: State.REASON });
    await runStepAgent(agent, mission.description, cfg, stagnationDetector, () => capturedComplete !== null);

    if (capturedComplete === null) {
      agent.steer({
        role: 'steer',
        content: '[REMINDER] You must call complete() to submit your execution plan.',
        timestamp: Date.now(),
      });
      await runStepAgent(agent, '', cfg, stagnationDetector, () => capturedComplete !== null);
    }

    if (capturedComplete !== null && capturedComplete['needsClarify'] === true && onNeedsClarify) {
      const questions = Array.isArray(capturedComplete['questions']) ? (capturedComplete['questions'] as string[]) : [];
      const answer = await onNeedsClarify(questions);
      capturedComplete = null;
      agent.steer({
        role: 'steer',
        content: `User answered: "${answer}". Now call complete(steps=[...]) with your updated execution plan. steps can be [] for direct Q&A.`,
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
      return { steps: [] };
    }
    const { steps, error } = parseReasonSteps(c);
    if (!error) {
      return { steps };
    }
    capturedComplete = null;
    agent.steer({
      role: 'steer',
      content: `[ERROR] complete() was called but the plan is invalid. ${error} Fix and call complete() again with valid steps.`,
      timestamp: Date.now(),
    });
    await runStepAgent(agent, '', cfg, stagnationDetector, () => capturedComplete !== null);
    if (capturedComplete !== null) {
      const { steps: retrySteps, error: retryError } = parseReasonSteps(capturedComplete);
      if (!retryError) {
        return { steps: retrySteps };
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
      const { steps, error } = parseReasonSteps(capturedComplete);
      if (!error) {
        return { steps };
      }
    }
  }

  return { steps: [] };
}

export async function runStep(
  step: Step,
  stepIndex: number,
  stepTotal: number,
  mission: Mission,
  stepResults: ExecutedStep[],
  cfg: RunConfig,
  onEvent?: (event: ExecutionEvent) => void,
  memoryIndex?: string,
  memorySearchTool?: AgentTool<any, any>,
): Promise<ExecutedStep> {
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
        snippets: Object.keys(result.snippets).length > 0 ? result.snippets : undefined,
      };
    } catch (e) {
      void e;
    }
  }

  const injectMemory = MEMORY_STATES.has(step.state) ? memoryIndex : undefined;
  const systemPrompt = buildSystemPrompt({
    state: step.state,
    task: mission.description,
    focus: step.focus,
    modelParams: cfg.stateMachine.getModelParams(),
    env: stepEnv,
    memoryIndex: injectMemory,
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
  const memoryTools: AgentTool<any, any>[] =
    memorySearchTool && (step.state === State.REASON || step.state === State.ANSWER) ? [memorySearchTool] : [];
  const stepCfg: typeof cfg = cfg;
  const agent = buildStepAgent(
    systemPrompt,
    [],
    stepCfg,
    onEvent,
    [...allowedTools, completeTool, ...memoryTools],
    readFiles,
  );

  subscribeStepEvents(
    agent,
    step.state,
    stagnationDetector,
    cfg,
    (text) => {
      llmText = text;
    },
    onEvent,
    () => {
      if (capturedComplete !== null) {
        const nextState = advanceState(step.state, trajectory);
        if (nextState !== step.state) {
          cfg.stateMachine.transitionTo(nextState);
          onEvent?.({ type: 'state_change', from: step.state, to: nextState });
        }
      }
    },
  );

  onEvent?.({ type: 'task_start', taskIndex: stepIndex, taskTotal: stepTotal, description: step.focus });
  onEvent?.({ type: 'state_change', from: State.REASON, to: step.state });

  const input = buildUserPrompt(step.state, mission.description, step.focus, stepResults);
  cfg.registerAgent?.(agent);
  try {
    await runStepAgent(agent, input, cfg, stagnationDetector, () => capturedComplete !== null);

    if (capturedComplete === null) {
      agent.steer({
        role: 'steer',
        content: `[REMINDER] You must call complete() now. Do NOT output any text — call complete() directly as your only action. Required fields: ${REMINDER_FIELDS[step.state] ?? 'see system prompt'}.`,
        timestamp: Date.now(),
      });
      await runStepAgent(agent, '', cfg, stagnationDetector, () => capturedComplete !== null);
    }
  } finally {
    cfg.unregisterAgent?.(agent);
  }

  onEvent?.({ type: 'task_end', taskIndex: stepIndex, taskTotal: stepTotal });

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

export async function executeSteps(
  directives: StepDirective[],
  mission: Mission,
  allStepResults: ExecutedStep[],
  cfg: RunConfig,
  onEvent?: (event: ExecutionEvent) => void,
  memoryIndex?: string,
  memorySearchTool?: AgentTool<any, any>,
): Promise<ExecutedStep[]> {
  const thisRoundResults: ExecutedStep[] = [];
  const total = directives.length;

  for (let i = 0; i < total; i++) {
    const directive = directives[i]!;

    if ('parallel' in directive) {
      const parallelSteps = directive.parallel;

      if (parallelSteps.length === 1) {
        const snapshot = [...allStepResults, ...thisRoundResults];
        const result = await runStep(
          parallelSteps[0]!,
          i,
          total,
          mission,
          snapshot,
          cfg,
          onEvent,
          memoryIndex,
          memorySearchTool,
        );
        thisRoundResults.push(result);
        continue;
      }

      onEvent?.({ type: 'parallel_start', stepCount: parallelSteps.length });

      const branchOnEvent = onEvent
        ? (e: ExecutionEvent) => {
            if (e.type !== 'state_change' && e.type !== 'task_start') onEvent(e);
          }
        : undefined;

      const settled = await Promise.allSettled(
        parallelSteps.map((step) => {
          const clonedCfg = { ...cfg, stateMachine: cfg.stateMachine.clone(), safeModifier: new SafeModifier() };
          const snapshot = [...allStepResults, ...thisRoundResults];
          return runStep(step, i, total, mission, snapshot, clonedCfg, branchOnEvent, memoryIndex, memorySearchTool);
        }),
      );

      const parallelResults: ExecutedStep[] = settled.map((r, idx) => {
        if (r.status === 'fulfilled') return r.value;
        const step = parallelSteps[idx]!;
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        return { state: step.state, focus: step.focus, output: JSON.stringify({ error: reason }) };
      });

      thisRoundResults.push(...parallelResults);
      onEvent?.({ type: 'parallel_complete', stepCount: parallelSteps.length });
    } else {
      const snapshot = [...allStepResults, ...thisRoundResults];
      const result = await runStep(directive, i, total, mission, snapshot, cfg, onEvent, memoryIndex, memorySearchTool);
      thisRoundResults.push(result);
    }
  }

  return thisRoundResults;
}
