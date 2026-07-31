import { runReasonAttempt } from '../agent/reason-runner.js';
import { forkRunConfig } from '../agent/step-context.js';
import type { StepDirective } from '../types.js';
import type { RunConfig, Mission, ExecutionEvent } from '../agent/types.js';
import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import type { PlanCandidate } from './types.js';
import { allSeenBefore, dedupPlans, newPlans, roundConverged } from './plan-set.js';
import { DEFAULT_SAMPLING_TEMPERATURE } from '../../config/defaults.js';

export const SAMPLING_BATCH_SIZE = 2;
const MAX_ROUNDS = 3;

function getMaxCount(tier: string): number {
  return tier === 'MEDIUM' ? 3 : 5;
}

export interface SamplerConfig {
  samplingTemperature?: number;
  /** Injected into every sample's REASON prompt (Gap 42 anchor). */
  memoryIndex?: string;
  /** Attached to every sample's tool list. */
  memorySearchTool?: AgentTool;
}

async function runBatch(
  mission: Mission,
  cfg: RunConfig,
  conversationHistory: AgentMessage[],
  batchSize: number,
  startIndex: number,
  samplingTemp: number,
  samplerCfg: SamplerConfig,
  onEvent?: (event: ExecutionEvent) => void,
): Promise<PlanCandidate[]> {
  let completed = 0;
  const tasks = Array.from({ length: batchSize }, (_, i) => {
    const idx = startIndex + i;
    onEvent?.({ type: 'sample_start', index: idx, total: startIndex + batchSize });
    return runOneSample(
      mission,
      { ...cfg, temperature: samplingTemp },
      conversationHistory,
      idx,
      samplerCfg,
      onEvent,
    ).then(
      (r) => {
        completed++;
        onEvent?.({ type: 'sample_complete', index: idx, steps: r.steps });
        onEvent?.({ type: 'sampling_progress', completed, total: batchSize });
        return { id: `plan-${idx}`, steps: r.steps } as PlanCandidate;
      },
      () => {
        completed++;
        onEvent?.({ type: 'sample_failed', index: idx });
        onEvent?.({ type: 'sampling_progress', completed, total: batchSize });
        return null;
      },
    );
  });
  const results = await Promise.all(tasks);
  const failed = results.filter((r) => r === null).length;
  if (failed > 0)
    console.warn('[sampler] ' + failed + '/' + results.length + ' samples failed in batch at index ' + startIndex);
  return results.flatMap((r) => (r !== null ? [r] : []));
}

export async function samplePlans(
  mission: Mission,
  cfg: RunConfig,
  conversationHistory: AgentMessage[],
  samplerCfg: SamplerConfig = {},
  onEvent?: (event: ExecutionEvent) => void,
  seedCandidates: PlanCandidate[] = [],
  indexOffset = 0,
): Promise<PlanCandidate[]> {
  const samplingTemp = samplerCfg.samplingTemperature ?? DEFAULT_SAMPLING_TEMPERATURE;
  const maxCount = getMaxCount(cfg.stateMachine.getModelParams().tier);

  let candidates = dedupPlans(seedCandidates);
  let sampleIndex = Math.max(candidates.length, indexOffset);

  const firstBatch = await runBatch(
    mission,
    cfg,
    conversationHistory,
    SAMPLING_BATCH_SIZE,
    sampleIndex,
    samplingTemp,
    samplerCfg,
    onEvent,
  );
  sampleIndex += SAMPLING_BATCH_SIZE;

  if (firstBatch.length === 0) return candidates;

  const newInFirst = newPlans(firstBatch, candidates);

  if (newInFirst.length === 0) {
    onEvent?.({ type: 'sampling_stopped', reason: 'no_new_info' });
    return candidates;
  }

  candidates = dedupPlans([...candidates, ...firstBatch]);

  if (roundConverged(newInFirst)) {
    onEvent?.({ type: 'sampling_stopped', reason: 'converged' });
    return candidates;
  }

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (candidates.length >= maxCount) {
      onEvent?.({ type: 'sampling_stopped', reason: 'max_count' });
      break;
    }

    onEvent?.({ type: 'sampling_expand', round, reason: 'divergent' });

    const expandBatch = await runBatch(
      mission,
      cfg,
      conversationHistory,
      SAMPLING_BATCH_SIZE,
      sampleIndex,
      samplingTemp,
      samplerCfg,
      onEvent,
    );
    sampleIndex += SAMPLING_BATCH_SIZE;

    if (expandBatch.length === 0) {
      onEvent?.({ type: 'sampling_stopped', reason: 'no_new_info' });
      break;
    }

    if (allSeenBefore(expandBatch, candidates)) {
      onEvent?.({ type: 'sampling_stopped', reason: 'no_new_info' });
      break;
    }

    candidates = dedupPlans([...candidates, ...expandBatch]);

    if (round === MAX_ROUNDS) {
      onEvent?.({ type: 'sampling_stopped', reason: 'max_rounds' });
    }
  }

  return candidates;
}

async function runOneSample(
  mission: Mission,
  cfg: RunConfig,
  conversationHistory: AgentMessage[],
  sampleIndex: number,
  samplerCfg: SamplerConfig,
  onEvent?: (event: ExecutionEvent) => void,
): Promise<{ steps: StepDirective[] }> {
  // One fork home (step-context.ts): shared safeModifier, cloned stateMachine
  // — same semantics as parallel branches. Temperature was already applied
  // by the caller's spread above; the fork carries it through.
  const isolatedCfg = forkRunConfig(cfg);

  const sampleOnEvent = (event: ExecutionEvent): void => {
    if (event.type === 'message_thinking_update' || event.type === 'message_thinking_end') {
      onEvent?.({ type: 'sample_thinking', index: sampleIndex, content: event.content });
    }
  };

  // One shared implementation with the real REASON step: samples plan with
  // the same memory injection and REMINDER retries (no behavioral drift).
  return runReasonAttempt(mission, isolatedCfg, conversationHistory, {
    onEvent: sampleOnEvent,
    memoryIndex: samplerCfg.memoryIndex,
    memorySearchTool: samplerCfg.memorySearchTool,
    throwOnFailure: true,
  });
}
