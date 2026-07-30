import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import { State } from '../types.js';
import type { StepDirective } from '../types.js';
import type { ExecutionEvent, Mission, RunConfig } from '../agent/types.js';
import { runReasonAttempt } from '../agent/reason-runner.js';
import { flattenDirectives } from '../agent/directives.js';
import { samplePlans, SAMPLING_BATCH_SIZE } from './sampler.js';
import { deliberate, pickShortest } from './deliberator.js';
import type { PlanCandidate } from './types.js';

export interface HeavyPlanOptions {
  onEvent?: (event: ExecutionEvent) => void;
  onNeedsClarify?: (questions: string[]) => Promise<string>;
  memoryIndex?: string;
  memorySearchTool?: AgentTool;
}

/**
 * Heavy Thinking orchestration — phase-0 seed → adaptive sampling →
 * deliberation → optional clarification re-sample → fallbacks. One deep
 * entry point so runReasonStep is a tier gate plus a dispatch, and the
 * REASON path no longer requires four open files (third-pass review,
 * candidate 11). Moved verbatim from step-runner.ts.
 */
export async function planWithHeavyThinking(
  mission: Mission,
  cfg: RunConfig,
  conversationHistory: AgentMessage[],
  options: HeavyPlanOptions = {},
): Promise<{ steps: StepDirective[] }> {
  const { onEvent, onNeedsClarify, memoryIndex, memorySearchTool } = options;
  const htCfg = cfg.heavyThinking;

  onEvent?.({ type: 'state_change', from: 'IDLE', to: State.REASON });

  const phase0OnEvent = onEvent
    ? (event: ExecutionEvent) => {
        if (event.type === 'state_change') return;
        onEvent(event);
      }
    : undefined;

  let phase0Candidate: PlanCandidate | null = null;
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
    phase0Candidate = { id: 'plan-phase0', steps: phase0Result.steps };
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
    onEvent?.({
      type: 'deliberation_fallback',
      reason: 'all samples failed, falling back to a single planning attempt',
    });
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
