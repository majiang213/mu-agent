import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { StagnationDetector } from '../cognitive/index.js';
import { DEFAULT_CONTEXT_RATIO } from '../../config/defaults.js';
import { fetchContextLength, OLLAMA_DUMMY_API_KEY } from '../../provider/model-info.js';
import { CodeGraphLocator } from '../graph/locator.js';
import { buildCompleteTool } from '../../tool/complete.js';
import { compressConversationHistoryWithLLM } from '../compaction/index.js';
import { buildSystemPrompt, buildUserPrompt } from '../prompts/agent.js';
import { buildStepAgent, subscribeStepEvents } from './builder.js';
import { runReasonAttempt, runStepAgent } from './reason-runner.js';
import { samplePlans, SAMPLING_BATCH_SIZE } from '../heavy/sampler.js';
import { deliberate, pickShortest } from '../heavy/deliberator.js';
import { State } from '../types.js';
import type { ExecutionEvent, Mission, RunConfig } from './types.js';
import type { Step, ExecutedStep, StepDirective } from '../types.js';
import { STATE_REGISTRY } from '../state-registry.js';
import { parseDirectives, flattenDirectives } from './directives.js';
import {
  forkParallelBranchConfig,
  findOverlappingEdits,
  parseEditedFiles,
  applyStateToolPolicy,
} from './step-context.js';

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
  apiKey = OLLAMA_DUMMY_API_KEY,
): Promise<AgentMessage[]> {
  if (messages.length === 0) return [];
  return compressConversationHistoryWithLLM(messages, model, contextRatio, apiKey);
}

/** Options threaded through step execution (4c — replaces 7-9 positional params). */
export interface StepRunOptions {
  onEvent?: (event: ExecutionEvent) => void;
  memoryIndex?: string;
  memorySearchTool?: AgentTool;
}

export interface ReasonStepOptions extends StepRunOptions {
  onNeedsClarify?: (questions: string[]) => Promise<string>;
}

export async function runReasonStep(
  mission: Mission,
  cfg: RunConfig,
  conversationHistory: AgentMessage[],
  options: ReasonStepOptions = {},
): Promise<{ steps: StepDirective[] }> {
  const { onEvent, onNeedsClarify, memoryIndex, memorySearchTool } = options;
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

export async function runStep(
  step: Step,
  stepIndex: number,
  stepTotal: number,
  mission: Mission,
  stepResults: ExecutedStep[],
  cfg: RunConfig,
  options: StepRunOptions = {},
): Promise<ExecutedStep> {
  const { onEvent, memoryIndex, memorySearchTool } = options;
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

  const allowedTools = applyStateToolPolicy(cfg.stateMachine.getAllowedTools());
  const stagnationDetector = new StagnationDetector({
    checkNoProgress: STATE_REGISTRY[step.state]?.readOnly !== true,
  });
  let llmText = '';
  let capturedComplete: Record<string, unknown> | null = null;

  const completeTool = buildCompleteTool(step.state, (args) => {
    capturedComplete = args;
  });
  const readFiles = new Set<string>();
  const memoryTools: AgentTool[] =
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
  options: StepRunOptions = {},
): Promise<ExecutedStep[]> {
  const { onEvent, memoryIndex, memorySearchTool } = options;
  const thisRoundResults: ExecutedStep[] = [];
  const total = directives.length;

  for (let i = 0; i < total; i++) {
    const directive = directives[i]!;

    if ('subplan' in directive) {
      const spec = directive.subplan;
      const planStep: Step = { state: spec.analyzerState, focus: spec.focus };

      onEvent?.({ type: 'subplan_start', analyzerState: spec.analyzerState, focus: spec.focus });

      const subplanSnapshot = [...allStepResults, ...thisRoundResults];
      const planResult = await runStep(planStep, i, total, mission, subplanSnapshot, cfg, {
        onEvent,
        memoryIndex,
        memorySearchTool,
      });
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
        const subResults = await executeSteps(subDirectives, mission, [...allStepResults, ...thisRoundResults], cfg, {
          onEvent,
          memoryIndex,
          memorySearchTool,
        });
        thisRoundResults.push(...subResults);
      }
    } else if ('parallel' in directive) {
      const parallelSteps = directive.parallel;

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
          return runStep(step, i, total, mission, snapshot, branchCfg, {
            onEvent: branchOnEvent,
            memoryIndex,
            memorySearchTool,
          });
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
      const result = await runStep(directive, i, total, mission, snapshot, cfg, {
        onEvent,
        memoryIndex,
        memorySearchTool,
      });
      thisRoundResults.push(result);
    }
  }

  return thisRoundResults;
}
