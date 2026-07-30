import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { StagnationDetector } from '../cognitive/index.js';
import { retryDelayMs, sleep } from '../failure/index.js';
import {
  DEFAULT_TEMPERATURE,
  MAX_TEMPERATURE,
  RETRY_TEMPERATURE_STEP,
  DEFAULT_CONTEXT_RATIO,
} from '../../config/defaults.js';
import { fetchContextLength } from '../../provider/model-info.js';
import { CodeGraphLocator } from '../graph/locator.js';
import { buildCompleteTool } from '../../tool/complete.js';
import { compressConversationHistoryWithLLM } from '../compaction/index.js';
import { buildSystemPrompt, buildUserPrompt } from '../prompts/agent.js';
import { buildStepAgent, subscribeStepEvents, wrapWithGitGuard } from './builder.js';
import { samplePlans, SAMPLING_BATCH_SIZE } from '../heavy/sampler.js';
import { deliberate, pickShortest } from '../heavy/deliberator.js';
import { State } from '../types.js';
import type { ExecutionEvent, Mission, RunConfig } from './types.js';
import type { Step, ExecutedStep, StepDirective } from '../types.js';
import { STATE_REGISTRY } from '../state-registry.js';
import { parseDirectives, flattenDirectives } from './directives.js';
import { forkParallelBranchConfig, findOverlappingEdits, parseEditedFiles } from './step-context.js';

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

export async function compressConversationHistory(
  messages: AgentMessage[],
  model: Model<'openai-completions'>,
  contextRatio = DEFAULT_CONTEXT_RATIO,
  apiKey = 'ollama',
): Promise<AgentMessage[]> {
  if (messages.length === 0) return [];
  return compressConversationHistoryWithLLM(messages, model, contextRatio, apiKey);
}

export async function runStepAgent(
  agent: import('@earendil-works/pi-agent-core').Agent,
  input: string,
  cfg: RunConfig,
  stagnationDetector: StagnationDetector,
): Promise<void> {
  const maxRetries = Math.max(cfg.stateMachine.getModelParams().maxRetries, 3);
  const baseTemperature = cfg.temperature;
  let attempt = 0;
  let lastError: Error | undefined;
  try {
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
        await sleep(retryDelayMs(attempt));
        // Mutate the cfg we were given: buildStepAgent's streamFn closure
        // reads cfg.temperature lazily at call time, so this escalation
        // actually reaches the model. Restored in finally (per-step fork or
        // parent — either way nothing leaks out of this attempt).
        cfg.temperature = Math.min(DEFAULT_TEMPERATURE + attempt * RETRY_TEMPERATURE_STEP, MAX_TEMPERATURE);
        stagnationDetector.reset();
        cfg.stateMachine.resetForRetry();
        // Restore + clear only THIS step's checkpoints (owner = this step's
        // stateMachine instance) — the store is shared, a store-wide wipe
        // would disarm rollback for parallel siblings and prior steps.
        await cfg.safeModifier.restoreAndClearWhere(cfg.stateMachine);
      }
      attempt++;
    }
    throw lastError ?? new Error('runStepAgent: max retries exhausted');
  } finally {
    cfg.temperature = baseTemperature;
  }
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
  const heavyEnabled = (tier === 'SMALL' || tier === 'MEDIUM') && htCfg?.enabled !== false;

  if (!heavyEnabled) {
    return runReasonAttempt(mission, cfg, conversationHistory, {
      onEvent,
      onNeedsClarify,
      fromState: 'IDLE',
      memoryIndex,
      memorySearchTool,
    });
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
    const phase0Result = await runReasonAttempt(mission, cfg, conversationHistory, {
      onEvent: phase0OnEvent,
      fromState: 'IDLE',
      memoryIndex,
      memorySearchTool,
    });
    const flatSteps = flattenDirectives(phase0Result.steps);
    if (flatSteps.length <= 1) {
      return phase0Result;
    }
    onEvent?.({ type: 'state_change', from: State.REASON, to: 'SAMPLING' });
    onEvent?.({ type: 'deliberation_start', candidateCount: SAMPLING_BATCH_SIZE + 1 });
    onEvent?.({ type: 'sample_start', index: 0, total: SAMPLING_BATCH_SIZE + 1 });
    onEvent?.({ type: 'sample_complete', index: 0, steps: phase0Result.steps });
    phase0Candidate = { id: 'plan-phase0', steps: phase0Result.steps, sampledAt: Date.now() };
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
    { samplingTemperature: htCfg?.samplingTemperature, memoryIndex, memorySearchTool },
    onEvent,
    phase0Candidate ? [phase0Candidate] : [],
    1,
  );

  if (candidates.length === 0) {
    onEvent?.({ type: 'deliberation_fallback', reason: '所有采样失败，回退到单次规划' });
    return runReasonAttempt(mission, cfg, conversationHistory, {
      onEvent,
      onNeedsClarify,
      fromState: 'IDLE',
      memoryIndex,
      memorySearchTool,
    });
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
      memoryIndex,
      memorySearchTool,
    });
    if (candidates.length === 0) {
      onEvent?.({
        type: 'deliberation_fallback',
        reason: 'all samples failed after clarification, falling back to single attempt',
      });
      return runReasonAttempt(currentMission, cfg, conversationHistory, {
        onEvent,
        fromState: State.REASON,
        memoryIndex,
        memorySearchTool,
      });
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

export interface ReasonAttemptOptions {
  onEvent?: (event: ExecutionEvent) => void;
  onNeedsClarify?: (questions: string[]) => Promise<string>;
  /** Emit a state_change(from -> REASON) event before prompting. */
  fromState?: State | 'IDLE';
  memoryIndex?: string;
  memorySearchTool?: AgentTool<any, any>;
  /**
   * Throw instead of returning { steps: [] } when the attempt never produces
   * a valid plan (sampler semantics: the sample counts as failed).
   */
  throwOnFailure?: boolean;
}

/**
 * Run one REASON planning attempt: build the agent, prompt, and drive the
 * complete() capture with REMINDER retries and optional clarification.
 * The single implementation behind both the real REASON step and Heavy
 * Thinking samples (which run it with a cloned state machine and
 * throwOnFailure) — the two can no longer drift.
 */
export async function runReasonAttempt(
  mission: Mission,
  cfg: RunConfig,
  conversationHistory: AgentMessage[],
  options: ReasonAttemptOptions = {},
): Promise<{ steps: StepDirective[] }> {
  const { onEvent, onNeedsClarify, fromState, memoryIndex, memorySearchTool, throwOnFailure } = options;
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
  const agent = buildStepAgent(systemPrompt, conversationHistory, cfg, onEvent, [completeTool, ...extraTools]);
  subscribeStepEvents(agent, State.REASON, stagnationDetector, cfg, () => {}, onEvent);

  cfg.registerAgent?.(agent);
  try {
    if (fromState !== undefined) {
      onEvent?.({ type: 'state_change', from: fromState, to: State.REASON });
    }
    await runStepAgent(agent, mission.description, cfg, stagnationDetector);

    if (capturedComplete === null) {
      agent.steer({
        role: 'steer',
        content: '[REMINDER] You must call complete() to submit your execution plan.',
        timestamp: Date.now(),
      });
      await runStepAgent(agent, '[REMINDER] Call complete() now.', cfg, stagnationDetector);
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
      await runStepAgent(agent, '[REMINDER] Call complete() now.', cfg, stagnationDetector);
    }
  } finally {
    cfg.unregisterAgent?.(agent);
  }

  let lastParseError: string | null = null;
  if (capturedComplete !== null) {
    const c = capturedComplete;
    if (c['needsClarify'] === true) {
      return { steps: [] };
    }
    const { steps, error } = parseDirectives(c);
    if (!error) {
      return { steps };
    }
    lastParseError = error;
    capturedComplete = null;
    agent.steer({
      role: 'steer',
      content: `[ERROR] complete() was called but the plan is invalid. ${error} Fix and call complete() again with valid steps.`,
      timestamp: Date.now(),
    });
    await runStepAgent(agent, '[REMINDER] Call complete() now.', cfg, stagnationDetector);
    if (capturedComplete !== null) {
      const { steps: retrySteps, error: retryError } = parseDirectives(capturedComplete);
      if (!retryError) {
        return { steps: retrySteps };
      }
      lastParseError = retryError;
    }
  } else {
    agent.steer({
      role: 'steer',
      content: '[ERROR] You did not call complete(). You MUST call complete(steps=[...]) now to submit your plan.',
      timestamp: Date.now(),
    });
    await runStepAgent(agent, '[REMINDER] Call complete() now.', cfg, stagnationDetector);
    if (capturedComplete !== null) {
      const { steps, error } = parseDirectives(capturedComplete);
      if (!error) {
        return { steps };
      }
      lastParseError = error;
    }
  }

  if (throwOnFailure) {
    throw new Error(`bare sample: ${lastParseError ?? 'complete() not called'}`);
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
  cfg.stateMachine.resetForNextTask(step.state);

  let stepEnv = cfg.env;
  if (STATE_REGISTRY[step.state]?.needsCodeContext === true) {
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

  const injectMemory = STATE_REGISTRY[step.state]?.memoryIndex === true ? memoryIndex : undefined;
  const systemPrompt = buildSystemPrompt({
    state: step.state,
    task: mission.description,
    focus: step.focus,
    modelParams: cfg.stateMachine.getModelParams(),
    env: stepEnv,
    memoryIndex: injectMemory,
  });

  const allowedTools = cfg.stateMachine
    .getAllowedTools()
    .filter((t) => t.name !== 'complete')
    .map((t) => (t.name === 'bash' ? wrapWithGitGuard(t) : t));
  const stagnationDetector = new StagnationDetector({
    checkNoProgress: STATE_REGISTRY[step.state]?.readOnly !== true,
  });
  let llmText = '';
  let capturedComplete: Record<string, unknown> | null = null;

  const completeTool = buildCompleteTool(step.state, (args) => {
    capturedComplete = args;
  });
  const readFiles = new Set<string>();
  const memoryTools: AgentTool<any, any>[] =
    memorySearchTool && STATE_REGISTRY[step.state]?.memorySearchTool === true ? [memorySearchTool] : [];
  const agent = buildStepAgent(
    systemPrompt,
    [],
    cfg,
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
        cfg.stateMachine.transitionTo(State.DONE);
        onEvent?.({ type: 'state_change', from: step.state, to: State.DONE });
      }
    },
  );

  onEvent?.({ type: 'task_start', taskIndex: stepIndex, taskTotal: stepTotal, description: step.focus });
  onEvent?.({ type: 'state_change', from: cfg.stateMachine.getCurrentState(), to: step.state });

  const input = buildUserPrompt(step.state, mission.description, step.focus, stepResults);
  cfg.registerAgent?.(agent);
  try {
    await runStepAgent(agent, input, cfg, stagnationDetector);

    if (capturedComplete === null) {
      agent.steer({
        role: 'steer',
        content: `[REMINDER] You must call complete() now. Do NOT output any text — call complete() directly as your only action. Required fields: ${STATE_REGISTRY[step.state]?.reminderFields ?? 'see system prompt'}.`,
        timestamp: Date.now(),
      });
      await runStepAgent(agent, '[REMINDER] Call complete() now.', cfg, stagnationDetector);
    }
  } finally {
    cfg.unregisterAgent?.(agent);
  }

  onEvent?.({ type: 'task_end', taskIndex: stepIndex, taskTotal: stepTotal });

  if (step.state === State.MODIFY && capturedComplete !== null) {
    try {
      const { resolve: pathResolve, relative } = await import('node:path');
      const edited = Array.isArray(capturedComplete['edited']) ? (capturedComplete['edited'] as string[]) : [];
      if (edited.length > 0) {
        const absPaths = edited
          .map((f) => (f.startsWith('/') ? f : `${cfg.projectRoot}/${f}`))
          .map((f) => pathResolve(f));
        const safePaths = absPaths.filter((f) => {
          const rel = relative(cfg.projectRoot, f);
          return rel && !rel.startsWith('..') && !rel.startsWith('/');
        });
        if (safePaths.length > 0) {
          const locator = new CodeGraphLocator(cfg.projectRoot);
          locator.updateFiles(safePaths);
        }
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

    if ('subplan' in directive) {
      const spec = directive.subplan;
      const planStep: Step = { state: spec.analyzerState, focus: spec.focus };

      onEvent?.({ type: 'subplan_start', analyzerState: spec.analyzerState, focus: spec.focus });

      const subplanSnapshot = [...allStepResults, ...thisRoundResults];
      const planResult = await runStep(
        planStep,
        i,
        total,
        mission,
        subplanSnapshot,
        cfg,
        onEvent,
        memoryIndex,
        memorySearchTool,
      );
      thisRoundResults.push(planResult);

      let subDirectives: StepDirective[] = [];
      let parseFailed = false;
      let parseError = '';
      try {
        const parsed = JSON.parse(planResult.output) as Record<string, unknown>;
        const { steps: parsedSteps, error } = parseDirectives(parsed);
        if (error || parsedSteps.length === 0) {
          parseFailed = true;
          parseError = error ?? 'empty steps';
        } else {
          subDirectives = parsedSteps.filter((d) => !('subplan' in d));
        }
      } catch (e) {
        parseFailed = true;
        parseError = e instanceof Error ? e.message : String(e);
      }

      if (parseFailed) {
        // Gap 82-A: subplan output unparseable — mark the PLAN step as failed so the
        // task surfaces failure instead of silently reporting "success" with no work done.
        // Skip sub-step expansion; the top-level ANSWER will present the failure.
        onEvent?.({ type: 'plan_parse_error', analyzerState: spec.analyzerState, output: planResult.output });
        const failedIdx = thisRoundResults.indexOf(planResult);
        if (failedIdx >= 0) {
          thisRoundResults[failedIdx] = {
            ...planResult,
            output: JSON.stringify({
              failed: true,
              error: `subplan output unparseable: ${parseError}`,
              rawOutput: planResult.output.slice(0, 500),
            }),
          };
        }
      }

      if (subDirectives.length > 0) {
        onEvent?.({ type: 'subplan_complete', subStepCount: subDirectives.length });
        const subResults = await executeSteps(
          subDirectives,
          mission,
          [...allStepResults, ...thisRoundResults],
          cfg,
          onEvent,
          memoryIndex,
          memorySearchTool,
        );
        thisRoundResults.push(...subResults);
      }
    } else if ('parallel' in directive) {
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
          // forkParallelBranchConfig: cloned state machine per branch, but a
          // SHARED safeModifier — rollback must see every branch's checkpoints.
          const branchCfg = forkParallelBranchConfig(cfg);
          const snapshot = [...allStepResults, ...thisRoundResults];
          return runStep(step, i, total, mission, snapshot, branchCfg, branchOnEvent, memoryIndex, memorySearchTool);
        }),
      );

      const parallelResults: ExecutedStep[] = settled.map((r, idx) => {
        if (r.status === 'fulfilled') return r.value;
        const step = parallelSteps[idx]!;
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        return { state: step.state, focus: step.focus, output: JSON.stringify({ error: reason }) };
      });

      // Overlap audit: two branches editing the same file makes checkpoint
      // ordering undefined, so rollback may not restore the original content.
      const overlapping = findOverlappingEdits(parallelResults.map((r) => parseEditedFiles(r.output)));
      if (overlapping.length > 0) {
        onEvent?.({ type: 'parallel_overlap', files: overlapping });
      }

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
