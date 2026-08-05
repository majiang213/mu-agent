import { runReasonAttempt } from '../agent/reason-runner.js';
import { forkRunConfig } from '../agent/step-context.js';
import type { StepDirective } from '../types.js';
import type { RunConfig, Mission, ExecutionEvent } from '../agent/types.js';
import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import type { PlanCandidate } from './types.js';
import { dedupPlans, newPlans, roundConverged } from './plan-set.js';
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
  /**
   * Test seam (round-7, candidate 2): replace the ONE LLM attempt per
   * sample. The fork + thinking-event mapping stay here in the sampler;
   * only the attempt call is injectable, so tests fake plans through config
   * instead of mocking reason-runner's module graph (same discipline as the
   * StepAgentDriver seam). Default: runReasonAttempt with throwOnFailure.
   */
  runSample?: SampleAttempt;
}

/** The one injectable unit of sampling: mission + forked cfg → planned steps (throws = failed sample). */
export type SampleAttempt = (
  mission: Mission,
  isolatedCfg: RunConfig,
  conversationHistory: AgentMessage[],
  options: { onEvent?: (event: ExecutionEvent) => void; memoryIndex?: string; memorySearchTool?: AgentTool },
) => Promise<{ steps: StepDirective[] }>;

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
  const tasks = Array.from({ length: batchSize }, (_, i) => {
    const idx = startIndex + i;
    // No `total` — the tree glyph (├/└) is the SamplingBlock's render-time
    // knowledge, computed from its own child count (round-5, candidate 8).
    onEvent?.({ type: 'sample_start', index: idx });
    return runOneSample(
      mission,
      { ...cfg, temperature: samplingTemp },
      conversationHistory,
      idx,
      samplerCfg,
      onEvent,
    ).then(
      (r) => {
        onEvent?.({ type: 'sample_complete', index: idx, steps: r.steps });
        return { steps: r.steps };
      },
      () => {
        onEvent?.({ type: 'sample_failed', index: idx });
        return null;
      },
    );
  });
  const results = await Promise.all(tasks);
  // No console.warn here (round-5 hygiene): failed samples already surface
  // through the typed sample_failed events — a stderr write only pollutes
  // the TUI's managed display.
  return results.flatMap((r) => (r !== null ? [r] : []));
}

export async function samplePlans(
  mission: Mission,
  cfg: RunConfig,
  conversationHistory: AgentMessage[],
  samplerCfg: SamplerConfig = {},
  onEvent?: (event: ExecutionEvent) => void,
  seedCandidates: PlanCandidate[] = [],
): Promise<PlanCandidate[]> {
  const samplingTemp = samplerCfg.samplingTemperature ?? DEFAULT_SAMPLING_TEMPERATURE;
  const maxCount = getMaxCount(cfg.stateMachine.getModelParams().tier);

  let candidates = dedupPlans(seedCandidates);

  // Round-5 (candidate 8): the sampler owns the sample display protocol —
  // seed candidates (e.g. the planner's phase-0) get their sample events
  // here, instead of the planner faking them with hardcoded batch-size
  // knowledge.
  candidates.forEach((seed, seedIdx) => {
    onEvent?.({ type: 'sample_start', index: seedIdx });
    onEvent?.({ type: 'sample_complete', index: seedIdx, steps: seed.steps });
  });
  let sampleIndex = candidates.length;

  // One loop for the first batch AND expand rounds (round-8, candidate 5) —
  // the old split restated the run→fresh-check→merge shape with two
  // equivalent "nothing new" predicates and an emit asymmetry (batch-0
  // failure silent, expand failure emitting no_new_info).
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    if (round > 0 && candidates.length >= maxCount) {
      onEvent?.({ type: 'sampling_stopped', reason: 'max_count' });
      break;
    }
    if (round > 0) onEvent?.({ type: 'sampling_expand', round, reason: 'divergent' });

    const batch = await runBatch(
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

    const fresh = newPlans(batch, candidates);
    if (fresh.length === 0) {
      // Silent only for round-0 WHOLESALE failure (empty batch): the
      // planner's fallback reporting owns that case. An all-duplicate batch —
      // at any round — is a real "no new info" stop.
      if (batch.length > 0 || round > 0) onEvent?.({ type: 'sampling_stopped', reason: 'no_new_info' });
      break;
    }

    candidates = dedupPlans([...candidates, ...batch]);

    if (round === 0 && roundConverged(fresh)) {
      onEvent?.({ type: 'sampling_stopped', reason: 'converged' });
      break;
    }
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
  const attempt: SampleAttempt =
    samplerCfg.runSample ?? ((m, c, h, o) => runReasonAttempt(m, c, h, { ...o, throwOnFailure: true }));
  return attempt(mission, isolatedCfg, conversationHistory, {
    onEvent: sampleOnEvent,
    memoryIndex: samplerCfg.memoryIndex,
    memorySearchTool: samplerCfg.memorySearchTool,
  });
}
