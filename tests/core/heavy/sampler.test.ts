import { describe, it, expect, beforeEach } from 'vitest';
import { State } from '../../../src/core/types.js';
import type { PlanCandidate } from '../../../src/core/heavy/types.js';
import type { SampleAttempt } from '../../../src/core/heavy/sampler.js';
import { samplePlans } from '../../../src/core/heavy/sampler.js';
import type { RunConfig, ExecutionEvent } from '../../../src/core/agent/types.js';
import { makeRunConfig, makeStateMachineFake } from '../../helpers/run-config.js';

/**
 * samplePlans tests fake the ONE LLM attempt through SamplerConfig.runSample
 * (round-7, candidate 2) — no module-graph mocks; the fork + event mapping +
 * stop conditions under test are the sampler's own.
 */

function makeStep(state: State) {
  return { state, focus: `focus ${state}` };
}

function makePlan(states: State[]): PlanCandidate {
  return { steps: states.map(makeStep) };
}

function makeCfg(): RunConfig {
  return makeRunConfig({
    model: { id: 'test-model', provider: 'ollama', baseUrl: 'http://localhost/v1' } as RunConfig['model'],
    stateMachine: makeStateMachineFake({ tier: 'SMALL', extraParams: { maxFilesPerTask: 2 } }),
    temperature: 0.7,
    contextRatio: 0.75,
    apiKey: 'ollama',
  });
}

const MISSION = { id: 't', description: 'fix', state: 'running' as const };

describe('samplePlans — adaptive sampling', () => {
  beforeEach(() => {
    // nothing to clear — fakes are per-test through config
  });

  /** Each call returns the next plan round-robin (or throws for a failed sample). */
  function fakeAttempt(plans: PlanCandidate[]): SampleAttempt {
    let callCount = 0;
    return async () => {
      const plan = plans[callCount % plans.length]!;
      callCount++;
      return { steps: plan.steps };
    };
  }

  const failingAttempt: SampleAttempt = async () => {
    throw new Error('sample failed');
  };

  it('returns seed candidate immediately when first batch all fail', async () => {
    const seed = makePlan([State.LOCATE, State.MODIFY, State.VERIFY]);
    const result = await samplePlans(MISSION, makeCfg(), [], { runSample: failingAttempt }, undefined, [seed]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(seed);
  });

  it('stops with converged when first batch all have same state sequence', async () => {
    const plan = makePlan([State.LOCATE, State.MODIFY, State.VERIFY]);
    const events: ExecutionEvent[] = [];
    const result = await samplePlans(MISSION, makeCfg(), [], { runSample: fakeAttempt([plan, plan]) }, (e) =>
      events.push(e),
    );
    expect(events.some((e) => e.type === 'sampling_stopped' && e.reason === 'converged')).toBe(true);
    expect(result.length).toBe(1);
  });

  it('deduplicates candidates with same state sequence', async () => {
    const plan1 = makePlan([State.LOCATE, State.MODIFY]);
    const plan2 = makePlan([State.LOCATE, State.MODIFY]);
    const result = await samplePlans(MISSION, makeCfg(), [], { runSample: fakeAttempt([plan1, plan2]) });
    expect(result.length).toBe(1);
  });

  it('seed candidate with same seq as batch result is deduplicated', async () => {
    const seed = makePlan([State.LOCATE, State.MODIFY]);
    const plan = makePlan([State.LOCATE, State.MODIFY]);
    const result = await samplePlans(MISSION, makeCfg(), [], { runSample: fakeAttempt([plan, plan]) }, undefined, [
      seed,
    ]);
    expect(result.length).toBe(1);
  });

  it('fires sampling_stopped no_new_info when batch brings no new sequences', async () => {
    const seed = makePlan([State.LOCATE, State.MODIFY]);
    const same = makePlan([State.LOCATE, State.MODIFY]);
    const events: ExecutionEvent[] = [];
    await samplePlans(MISSION, makeCfg(), [], { runSample: fakeAttempt([same, same]) }, (e) => events.push(e), [seed]);
    expect(events.some((e) => e.type === 'sampling_stopped' && e.reason === 'no_new_info')).toBe(true);
  });

  it('fires sample_start events with sequential indices', async () => {
    const plan = makePlan([State.MODIFY]);
    const events: ExecutionEvent[] = [];
    await samplePlans(MISSION, makeCfg(), [], { runSample: fakeAttempt([plan, plan]) }, (e) => events.push(e), []);
    const indices = events
      .filter((e) => e.type === 'sample_start')
      .map((e) => (e as { type: 'sample_start'; index: number }).index);
    expect(indices).toEqual([0, 1]);
  });

  it('emits sample events for seed candidates — the sampler owns the protocol (round-5)', async () => {
    const seed = makePlan([State.LOCATE, State.MODIFY]);
    const same = makePlan([State.LOCATE, State.MODIFY]);
    const events: ExecutionEvent[] = [];
    await samplePlans(MISSION, makeCfg(), [], { runSample: fakeAttempt([same, same]) }, (e) => events.push(e), [seed]);
    expect(events.some((e) => e.type === 'sample_start' && e.index === 0)).toBe(true);
    expect(events.some((e) => e.type === 'sample_complete' && e.index === 0)).toBe(true);
  });

  it('maps thinking events from the attempt into sample_thinking (the part the slot does NOT fake)', async () => {
    const thinkAttempt: SampleAttempt = async (_m, _c, _h, o) => {
      o.onEvent?.({ type: 'message_thinking_update', content: 'hmm' });
      return { steps: [makeStep(State.MODIFY)] };
    };
    const events: ExecutionEvent[] = [];
    await samplePlans(MISSION, makeCfg(), [], { runSample: thinkAttempt }, (e) => events.push(e), []);
    expect(events.some((e) => e.type === 'sample_thinking' && e.content === 'hmm')).toBe(true);
  });
});
