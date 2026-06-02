import { StagnationDetector } from '../cognitive/index.js';
import { buildCompleteTool } from '../../tool/complete.js';
import { buildSystemPrompt } from '../prompts/index.js';
import { buildStepAgent, subscribeStepEvents } from '../agent/builder.js';
import { runStepAgent, parseReasonSteps } from '../agent/step-runner.js';
import { State } from '../types.js';
import type { Step } from '../types.js';
import type { RunConfig, Mission, ExecutionEvent } from '../agent/types.js';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { PlanCandidate } from './types.js';
import { DEFAULT_SAMPLING_TEMPERATURE } from '../../config/defaults.js';

export const SAMPLING_BATCH_SIZE = 2;
const MAX_ROUNDS = 3;

function getMaxCount(tier: string): number {
  return tier === 'MEDIUM' ? 3 : 5;
}

export interface SamplerConfig {
  planCount?: number;
  samplingTemperature?: number;
}

function stateSeq(candidate: PlanCandidate): string {
  return candidate.steps.map((s) => s.state).join(',');
}

function roundConverged(roundCandidates: PlanCandidate[]): boolean {
  if (roundCandidates.length <= 1) return true;
  const seqs = new Set(roundCandidates.map(stateSeq));
  return seqs.size === 1;
}

function allSeenBefore(newCandidates: PlanCandidate[], existing: PlanCandidate[]): boolean {
  if (newCandidates.length === 0) return false;
  const existingSeqs = new Set(existing.map(stateSeq));
  return newCandidates.every((c) => existingSeqs.has(stateSeq(c)));
}

function dedup(candidates: PlanCandidate[]): PlanCandidate[] {
  const seen = new Map<string, PlanCandidate>();
  for (const c of candidates) {
    const seq = stateSeq(c);
    if (!seen.has(seq)) seen.set(seq, c);
  }
  return [...seen.values()];
}

async function runBatch(
  mission: Mission,
  cfg: RunConfig,
  conversationHistory: AgentMessage[],
  batchSize: number,
  startIndex: number,
  samplingTemp: number,
  onEvent?: (event: ExecutionEvent) => void,
): Promise<PlanCandidate[]> {
  let completed = 0;
  const tasks = Array.from({ length: batchSize }, (_, i) => {
    const idx = startIndex + i;
    onEvent?.({ type: 'sample_start', index: idx, total: startIndex + batchSize });
    return runBareReasonSample(mission, { ...cfg, temperature: samplingTemp }, conversationHistory, idx, onEvent).then(
      (r) => {
        completed++;
        onEvent?.({ type: 'sample_complete', index: idx, steps: r.steps });
        onEvent?.({ type: 'sampling_progress', completed, total: batchSize });
        return { id: `plan-${idx}`, steps: r.steps, sampledAt: Date.now() } as PlanCandidate;
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

  let candidates = dedup(seedCandidates);
  let sampleIndex = Math.max(candidates.length, indexOffset);

  const firstBatch = await runBatch(
    mission,
    cfg,
    conversationHistory,
    SAMPLING_BATCH_SIZE,
    sampleIndex,
    samplingTemp,
    onEvent,
  );
  sampleIndex += SAMPLING_BATCH_SIZE;

  if (firstBatch.length === 0) return candidates;

  const newInFirst = firstBatch.filter((c) => !candidates.some((e) => stateSeq(e) === stateSeq(c)));

  if (newInFirst.length === 0) {
    onEvent?.({ type: 'sampling_stopped', reason: 'no_new_info' });
    return candidates;
  }

  candidates = dedup([...candidates, ...firstBatch]);

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

    candidates = dedup([...candidates, ...expandBatch]);

    if (round === MAX_ROUNDS) {
      onEvent?.({ type: 'sampling_stopped', reason: 'max_rounds' });
    }
  }

  return candidates;
}

async function runBareReasonSample(
  mission: Mission,
  cfg: RunConfig,
  conversationHistory: AgentMessage[],
  sampleIndex: number,
  onEvent?: (event: ExecutionEvent) => void,
): Promise<{ steps: PlanCandidate['steps'] }> {
  const isolatedCfg = { ...cfg, stateMachine: cfg.stateMachine.clone() };
  isolatedCfg.stateMachine.transitionTo(State.REASON);
  const systemPrompt = buildSystemPrompt({
    state: State.REASON,
    task: mission.description,
    modelParams: isolatedCfg.stateMachine.getModelParams(),
    env: isolatedCfg.env,
  });

  let capturedComplete: Record<string, unknown> | null = null;
  const completeTool = buildCompleteTool(State.REASON, (args) => {
    capturedComplete = args;
  });

  const sampleOnEvent = (event: ExecutionEvent): void => {
    if (event.type === 'message_thinking_update' || event.type === 'message_thinking_end') {
      onEvent?.({ type: 'sample_thinking', index: sampleIndex, content: event.content });
    }
  };

  const stagnationDetector = new StagnationDetector();
  const agent = buildStepAgent(systemPrompt, conversationHistory, isolatedCfg, sampleOnEvent, [completeTool]);
  subscribeStepEvents(agent, State.REASON, stagnationDetector, isolatedCfg, () => {}, sampleOnEvent);

  isolatedCfg.registerAgent?.(agent);
  try {
    await runStepAgent(agent, mission.description, isolatedCfg, stagnationDetector, () => capturedComplete !== null);
  } finally {
    isolatedCfg.unregisterAgent?.(agent);
  }

  if (capturedComplete === null) {
    throw new Error('bare sample: complete() not called');
  }

  const stepsField = capturedComplete['steps'];
  const modelReturnedEmptySteps = Array.isArray(stepsField) && (stepsField as unknown[]).length === 0;
  const { steps: directives, error } = parseReasonSteps(capturedComplete);
  if (directives.length === 0 && !modelReturnedEmptySteps) {
    throw new Error(`bare sample: invalid plan — ${error ?? 'empty steps'}`);
  }
  const steps: Step[] = directives.flatMap((d) => ('parallel' in d ? d.parallel : [d]));

  return { steps };
}
