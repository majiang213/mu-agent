import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import { StagnationDetector } from '../cognitive/index.js';
import { buildCompleteTool } from '../../tool/complete.js';
import { resolveProjectPath } from '../../tool/safety/paths.js';
import { buildSystemPrompt, buildUserPrompt } from '../prompts/agent.js';
import { defaultStepDriver, runReasonAttempt } from './reason-runner.js';
import { planWithHeavyThinking } from '../heavy/planner.js';
import { State } from '../types.js';
import type { ExecutionEvent, Mission, RunConfig } from './types.js';
import type { Step, ExecutedStep, StepDirective } from '../types.js';
import { STATE_REGISTRY } from '../state-registry.js';
import { parseDirectives } from './directives.js';
import { forkRunConfig, findOverlappingEdits, applyStateToolPolicy } from './step-context.js';
import { editedFilesFromArgs, parseEditedFiles } from '../step-outputs.js';

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
  const tier = cfg.stateMachine.getModelParams().tier;
  const heavyEnabled = (tier === 'SMALL' || tier === 'MEDIUM') && cfg.heavyThinking?.enabled !== false;

  if (!heavyEnabled) {
    return runReasonAttempt(mission, cfg, conversationHistory, {
      onEvent,
      onNeedsClarify,
      fromState: 'IDLE',
      memoryIndex,
      memorySearchTool,
    });
  }

  // SMALL/MEDIUM tier → Heavy Thinking (phase-0 → sample → deliberate →
  // clarify → fallbacks) — one deep entry in heavy/planner.ts (C11).
  return planWithHeavyThinking(mission, cfg, conversationHistory, options);
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

  // Per-step spread: retry-temperature escalation mutates THIS copy via the
  // streamFn closure, never the shared RunConfig (C14). Services are still
  // shared by reference — only scalar writes are isolated.
  const stepCfg = { ...cfg };

  let stepEnv = cfg.env;
  if (STATE_REGISTRY[step.state]?.needsCodeContext === true && cfg.locator !== null) {
    try {
      // One locator per run, built by RunSetup — its BM25 cache survives
      // across steps. null means "no graph" (tests), so skip enrichment.
      const result = cfg.locator.locate(step.focus);
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
  // One injected collaborator (round-4, candidate 5): tests fake the driver
  // through this seam instead of mocking the module graph.
  const driver = cfg.stepDriver ?? defaultStepDriver;
  const agent = driver.buildAgent({
    systemPrompt,
    initialMessages: [],
    state: step.state,
    cfg: stepCfg,
    tools: [...allowedTools, completeTool, ...memoryTools],
    readFiles,
    stagnationDetector,
    onLlmText: (text) => {
      llmText = text;
    },
    onEvent,
    onTurnEndComplete: () => {
      if (capturedComplete !== null) {
        cfg.stateMachine.transitionTo(State.DONE);
        onEvent?.({ type: 'state_change', from: step.state, to: State.DONE });
      }
    },
  });

  onEvent?.({ type: 'task_start', taskIndex: stepIndex, taskTotal: stepTotal, description: step.focus });
  onEvent?.({ type: 'state_change', from: cfg.stateMachine.getCurrentState(), to: step.state });

  const input = buildUserPrompt(step.state, mission.description, step.focus, stepResults);
  cfg.registerAgent?.(agent);
  try {
    await driver.driveUntilComplete(agent, input, stepCfg, stagnationDetector, {
      hasCaptured: () => capturedComplete !== null,
      reminderSteer: `[REMINDER] You must call complete() now. Do NOT output any text — call complete() directly as your only action. Required fields: ${STATE_REGISTRY[step.state]?.reminderFields ?? 'see system prompt'}.`,
    });
  } finally {
    cfg.unregisterAgent?.(agent);
  }

  onEvent?.({ type: 'task_end', taskIndex: stepIndex, taskTotal: stepTotal });

  if (step.state === State.MODIFY && capturedComplete !== null) {
    try {
      const edited = editedFilesFromArgs(capturedComplete);
      if (edited.length > 0) {
        // THE containment check (tool/safety/paths.ts) — same normalized
        // resolution the checkpoint path uses.
        const safePaths = edited
          .map((f) => resolveProjectPath(cfg.projectRoot, f))
          .filter((r): r is { ok: true; abs: string } => r.ok)
          .map((r) => r.abs);
        if (safePaths.length > 0 && cfg.locator !== null) {
          cfg.locator.updateFiles(safePaths);
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
          // forkRunConfig: cloned state machine per branch, but a
          // SHARED safeModifier — rollback must see every branch's checkpoints.
          const branchCfg = forkRunConfig(cfg);
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
