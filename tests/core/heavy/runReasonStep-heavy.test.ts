import { describe, it, expect, vi, beforeEach } from 'vitest';
import { State } from '../../../src/core/types.js';
import type { RunConfig, ExecutionEvent, Mission } from '../../../src/core/agent/types.js';
import type { PlanCandidate, DeliberateOutcome } from '../../../src/core/heavy/types.js';
import { makeRunConfig, makeStateMachineFake } from '../../helpers/run-config.js';
import { runReasonStep } from '../../../src/core/agent/step-runner.js';
import type { HeavyPlanOptions } from '../../../src/core/heavy/planner.js';

/**
 * runReasonStep heavy-path tests drive the planner through its config slots
 * (round-7, candidate 2): runAttempt / sample / deliberate fakes — zero
 * module-graph mocks. Phase-0 "failure" is just a runAttempt that throws.
 */

function makePlan(states: State[]): PlanCandidate {
  return { steps: states.map((s, i) => ({ state: s, focus: `focus ${i}` })) };
}

function makeCfg(heavyThinking?: RunConfig['heavyThinking']): RunConfig {
  return makeRunConfig({
    model: { id: 'test-model', provider: 'ollama', baseUrl: 'http://localhost/v1' } as RunConfig['model'],
    stateMachine: makeStateMachineFake({ tier: 'SMALL', extraParams: { maxFilesPerTask: 2 } }),
    temperature: 0.1,
    contextRatio: 0.75,
    apiKey: 'ollama',
    ...(heavyThinking !== undefined ? { heavyThinking } : {}),
  });
}

function makeSelectedOutcome(plan: PlanCandidate): Extract<DeliberateOutcome, { type: 'selected' }> {
  return {
    type: 'selected',
    result: { synthesizedSteps: plan.steps, deliberationSummary: 'synthesized' },
  };
}

const MISSION = { id: 't', description: 'fix bug', state: 'running' as const };

/** Slots with the phase-0 attempt failing — the canonical heavy-path entry. */
function heavySlots(overrides: Partial<HeavyPlanOptions> = {}): HeavyPlanOptions {
  return {
    runAttempt: vi.fn(async () => {
      throw new Error('phase0 mocked failure');
    }),
    sample: vi.fn(async () => [makePlan([State.MODIFY])]),
    deliberate: vi.fn(async () => makeSelectedOutcome(makePlan([State.MODIFY]))),
    ...overrides,
  };
}

describe('runReasonStep — heavy path', () => {
  beforeEach(() => {
    // fakes are per-test through config slots — nothing module-global to clear
  });

  it('fires deliberation_start before sampling begins', async () => {
    const events: ExecutionEvent[] = [];
    await runReasonStep(MISSION, makeCfg(), [], {
      ...heavySlots(),
      onEvent: (e) => events.push(e),
    });
    const startEvent = events.find(
      (e): e is Extract<ExecutionEvent, { type: 'deliberation_start' }> => e.type === 'deliberation_start',
    );
    expect(startEvent).toBeDefined();
  });

  it('calls deliberate once when sampling succeeds', async () => {
    const slots = heavySlots();
    await runReasonStep(MISSION, makeCfg(), [], slots);
    expect(slots.deliberate).toHaveBeenCalledTimes(1);
  });

  it('returns synthesized steps', async () => {
    const synthesized = makePlan([State.DIAGNOSE, State.LOCATE, State.MODIFY, State.VERIFY]);
    const events: ExecutionEvent[] = [];
    const result = await runReasonStep(MISSION, makeCfg(), [], {
      ...heavySlots({
        sample: vi.fn(async () => [
          makePlan([State.LOCATE, State.MODIFY, State.VERIFY]),
          makePlan([State.MODIFY, State.VERIFY]),
        ]),
        deliberate: vi.fn(async () => makeSelectedOutcome(synthesized)),
      }),
      onEvent: (e) => events.push(e),
    });
    expect(result.steps).toEqual(synthesized.steps);
    expect(events.some((e) => e.type === 'deliberation_complete' && e.synthesizedStepCount === 4)).toBe(true);
  });

  it('re-samples after clarification answer', async () => {
    const plan0 = makePlan([State.LOCATE, State.MODIFY]);
    const plan1 = makePlan([State.DIAGNOSE, State.MODIFY]);
    const sample = vi.fn(async (_mission: Mission) => [plan0, plan1]);
    const deliberate = vi
      .fn()
      .mockResolvedValueOnce({ type: 'needs_clarification', question: 'Which file?' })
      .mockResolvedValueOnce(makeSelectedOutcome(plan0));
    const events: ExecutionEvent[] = [];
    const result = await runReasonStep(MISSION, makeCfg(), [], {
      ...heavySlots({ sample, deliberate }),
      onEvent: (e) => events.push(e),
      onNeedsClarify: async () => 'src/auth.ts',
    });
    expect(sample).toHaveBeenCalledTimes(2);
    expect(deliberate).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === 'deliberation_clarification')).toBe(true);
    expect(result.steps).toEqual(plan0.steps);
    const secondMissionDesc = vi.mocked(sample).mock.calls[1]![0].description;
    expect(secondMissionDesc).toContain('src/auth.ts');
  });

  it('second deliberate uses allowClarification=false', async () => {
    const plans = [makePlan([State.LOCATE, State.MODIFY]), makePlan([State.DIAGNOSE, State.MODIFY])];
    const deliberate = vi
      .fn()
      .mockResolvedValueOnce({ type: 'needs_clarification', question: 'Which file?' })
      .mockResolvedValueOnce(makeSelectedOutcome(plans[0]!));
    await runReasonStep(MISSION, makeCfg(), [], {
      ...heavySlots({ sample: vi.fn(async () => plans), deliberate }),
      onNeedsClarify: async () => 'answer',
    });
    expect(vi.mocked(deliberate).mock.calls[1]![4]).toBe(false);
  });

  it('fires deliberation_start and deliberation_fallback when samples array is empty', async () => {
    const events: ExecutionEvent[] = [];
    try {
      await runReasonStep(MISSION, makeCfg(), [], {
        ...heavySlots({ sample: vi.fn(async () => []) }),
        onEvent: (e) => events.push(e),
      });
    } catch {
      // runReasonStep may throw on the fallback path; the events are what matters.
    }
    expect(events.some((e) => e.type === 'deliberation_start')).toBe(true);
    expect(events.some((e) => e.type === 'deliberation_fallback')).toBe(true);
  });

  it('enters heavy thinking when phase0 fails (fallback path)', async () => {
    const plan = makePlan([State.LOCATE, State.MODIFY, State.VERIFY]);
    const events: ExecutionEvent[] = [];
    const slots = heavySlots({
      sample: vi.fn(async () => [plan]),
      deliberate: vi.fn(async () => makeSelectedOutcome(plan)),
    });
    await runReasonStep({ id: 't', description: 'fix bug in calc.js', state: 'running' }, makeCfg(), [], {
      ...slots,
      onEvent: (e) => events.push(e),
    });
    expect(events.some((e) => e.type === 'state_change' && e.to === 'SAMPLING')).toBe(true);
    expect(slots.sample).toHaveBeenCalledTimes(1);
  });
});
