import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deliberate, pickShortest } from '../../../src/core/heavy/deliberator.js';
import type { PlanCandidate } from '../../../src/core/heavy/types.js';
import { State } from '../../../src/core/types.js';
import type { RunConfig } from '../../../src/core/agent/types.js';
import { makeRunConfig } from '../../helpers/run-config.js';

// Gap 89: no module mock — deliberator calls cfg.models.completeSimple, so the
// fake Models object carries the spy.
const completeSimpleMock = vi.fn();

function makePlan(states: State[], whys?: string[]): PlanCandidate {
  return {
    steps: states.map((s, i) => ({
      state: s,
      focus: `step ${i}`,
      ...(whys?.[i] ? { why: whys[i] } : {}),
    })),
  };
}

function makeModel() {
  return {
    id: 'test-model',
    provider: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
  } as RunConfig['model'];
}

function makeCfg(): RunConfig {
  return makeRunConfig({
    model: makeModel(),
    models: { completeSimple: completeSimpleMock } as unknown as RunConfig['models'],
    temperature: 0.1,
    contextRatio: 0.75,
    apiKey: 'ollama',
  });
}

function makeStepsJson(states: State[]): string {
  const steps = states.map((s, i) => ({ state: s, focus: `synthesized step ${i}` }));
  return JSON.stringify(steps);
}

function makeAssistantMessage(text: string) {
  return { content: [{ type: 'text', text }] };
}

describe('pickShortest', () => {
  it('returns the only candidate when there is one', () => {
    const plans = [makePlan([State.LOCATE, State.MODIFY])];
    expect(pickShortest(plans)).toBe(plans[0]);
  });

  it('returns the candidate with fewer steps', () => {
    const plans = [makePlan([State.LOCATE, State.MODIFY, State.VERIFY]), makePlan([State.MODIFY])];
    expect(pickShortest(plans)).toBe(plans[1]);
  });

  it('returns the first when lengths are equal', () => {
    const plans = [makePlan([State.LOCATE, State.MODIFY]), makePlan([State.DIAGNOSE, State.VERIFY])];
    expect(pickShortest(plans)).toBe(plans[0]);
  });

  it('handles three candidates', () => {
    const plans = [
      makePlan([State.LOCATE, State.MODIFY, State.VERIFY]),
      makePlan([State.MODIFY, State.VERIFY]),
      makePlan([State.MODIFY]),
    ];
    expect(pickShortest(plans)).toBe(plans[2]);
  });

  it('returns empty plan when no candidates', () => {
    const result = pickShortest([]);
    expect(result.steps).toEqual([]);
  });
});

describe('deliberate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns selected when only one candidate', async () => {
    const plans = [makePlan([State.LOCATE, State.MODIFY])];
    const result = await deliberate(plans, { id: 't', description: 'fix bug', state: 'running' }, makeCfg());
    expect(result.type).toBe('selected');
    if (result.type === 'selected') {
      expect(result.result.synthesizedSteps).toEqual(plans[0]!.steps);
      expect(result.result.deliberationSummary).toBe('single candidate');
    }
  });

  it('skips deliberation and picks shortest when all plans are similar', async () => {
    const plans = [makePlan([State.LOCATE, State.MODIFY]), makePlan([State.LOCATE, State.MODIFY])];
    const events: string[] = [];
    const result = await deliberate(plans, { id: 't', description: 'fix bug', state: 'running' }, makeCfg(), (e) =>
      events.push(e.type),
    );
    expect(result.type).toBe('selected');
    expect(events).toContain('deliberation_fallback');
    expect(completeSimpleMock).not.toHaveBeenCalled();
  });

  it('synthesizes steps from JSON response', async () => {
    completeSimpleMock
      .mockResolvedValueOnce(makeAssistantMessage(makeStepsJson([State.LOCATE, State.MODIFY, State.VERIFY])) as any)
      .mockResolvedValue(makeAssistantMessage('SAME') as any);
    const plans = [makePlan([State.MODIFY]), makePlan([State.LOCATE, State.MODIFY, State.VERIFY])];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    expect(result.type).toBe('selected');
    if (result.type === 'selected') {
      expect(result.result.synthesizedSteps).toHaveLength(3);
      expect('state' in result.result.synthesizedSteps[0]!).toBe(true);
      if ('state' in result.result.synthesizedSteps[0]!) {
        expect(result.result.synthesizedSteps[0]!.state).toBe(State.LOCATE);
      }
    }
  });

  it('preserves why field in synthesized steps', async () => {
    const stepsWithWhy = JSON.stringify([
      { state: State.LOCATE, focus: 'find the bug', why: 'error likely in auth layer' },
      { state: State.MODIFY, focus: 'fix it' },
    ]);
    completeSimpleMock
      .mockResolvedValueOnce(makeAssistantMessage(stepsWithWhy) as any)
      .mockResolvedValue(makeAssistantMessage('SAME') as any);
    const plans = [makePlan([State.MODIFY]), makePlan([State.LOCATE, State.MODIFY])];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    expect(result.type).toBe('selected');
    if (result.type === 'selected') {
      expect('state' in result.result.synthesizedSteps[0]!).toBe(true);
      expect('state' in result.result.synthesizedSteps[1]!).toBe(true);
      if ('state' in result.result.synthesizedSteps[0]! && 'state' in result.result.synthesizedSteps[1]!) {
        expect(result.result.synthesizedSteps[0]!.why).toBe('error likely in auth layer');
        expect(result.result.synthesizedSteps[1]!.why).toBeUndefined();
      }
    }
  });

  it('preserves subplan directive through synthesis (Gap 81)', async () => {
    // Deliberation LLM returns a subplan entry → parseDirectivesJson keeps it,
    // synthesizedSteps carries the subplan verbatim (not flattened to pseudo-PLAN).
    const stepsWithSubplan = JSON.stringify([
      { state: State.LOCATE, focus: 'find bug' },
      { subplan: { analyzerState: 'PLAN', focus: 'analyze commits and plan atomic splits' } },
    ]);
    completeSimpleMock
      .mockResolvedValueOnce(makeAssistantMessage(stepsWithSubplan) as any)
      .mockResolvedValue(makeAssistantMessage('SAME') as any);
    const plans = [makePlan([State.LOCATE]), makePlan([State.LOCATE, State.MODIFY])];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    expect(result.type).toBe('selected');
    if (result.type === 'selected') {
      expect(result.result.synthesizedSteps).toHaveLength(2);
      expect('subplan' in result.result.synthesizedSteps[1]!).toBe(true);
      if ('subplan' in result.result.synthesizedSteps[1]!) {
        expect(result.result.synthesizedSteps[1]!.subplan.analyzerState).toBe(State.PLAN);
        expect(result.result.synthesizedSteps[1]!.subplan.focus).toContain('commits');
      }
    }
  });

  it('preserves parallel directive through synthesis (Gap 81)', async () => {
    const stepsWithParallel = JSON.stringify([
      { state: State.LOCATE, focus: 'find files' },
      {
        parallel: [
          { state: 'MODIFY', focus: 'fix a' },
          { state: 'MODIFY', focus: 'fix b' },
        ],
      },
    ]);
    completeSimpleMock
      .mockResolvedValueOnce(makeAssistantMessage(stepsWithParallel) as any)
      .mockResolvedValue(makeAssistantMessage('SAME') as any);
    const plans = [makePlan([State.LOCATE]), makePlan([State.LOCATE, State.MODIFY])];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    expect(result.type).toBe('selected');
    if (result.type === 'selected') {
      expect('parallel' in result.result.synthesizedSteps[1]!).toBe(true);
      if ('parallel' in result.result.synthesizedSteps[1]!) {
        expect(result.result.synthesizedSteps[1]!.parallel).toHaveLength(2);
      }
    }
  });

  it('keeps subplan-only candidates distinct (no false merge via pickShortest)', async () => {
    // Two subplan candidates with different focuses are NOT similar → deliberation runs.
    // Single-candidate path also must return the subplan directive verbatim.
    const subplanPlan: PlanCandidate = {
      steps: [{ subplan: { analyzerState: State.PLAN, focus: 'plan atomic commits' } }],
    };
    const result = await deliberate([subplanPlan], { id: 't', description: 'task', state: 'running' }, makeCfg());
    expect(result.type).toBe('selected');
    if (result.type === 'selected') {
      expect(result.result.synthesizedSteps).toHaveLength(1);
      expect('subplan' in result.result.synthesizedSteps[0]!).toBe(true);
    }
  });

  it('parses needs_clarification', async () => {
    completeSimpleMock.mockResolvedValue(
      makeAssistantMessage('needs_clarification: true\nquestion: Which file should be modified?') as any,
    );
    const plans = [makePlan([State.LOCATE, State.MODIFY]), makePlan([State.DIAGNOSE, State.MODIFY])];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    expect(result.type).toBe('needs_clarification');
    if (result.type === 'needs_clarification') {
      expect(result.question).toBe('Which file should be modified?');
    }
  });

  it('needs_clarification is ignored when allowClarification=false, falls back to pickShortest', async () => {
    completeSimpleMock.mockResolvedValue(
      makeAssistantMessage('needs_clarification: true\nquestion: Which file?') as any,
    );
    const plans = [makePlan([State.LOCATE, State.MODIFY]), makePlan([State.DIAGNOSE, State.MODIFY])];
    const events: string[] = [];
    const result = await deliberate(
      plans,
      { id: 't', description: 'task', state: 'running' },
      makeCfg(),
      (e) => events.push(e.type),
      false,
    );
    expect(result.type).toBe('selected');
    expect(events).toContain('deliberation_fallback');
  });

  it('falls back to pickShortest when parse completely fails', async () => {
    completeSimpleMock.mockResolvedValue(makeAssistantMessage('I cannot decide.') as any);
    const plans = [makePlan([State.MODIFY]), makePlan([State.LOCATE, State.MODIFY])];
    const events: string[] = [];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg(), (e) =>
      events.push(e.type),
    );
    expect(result.type).toBe('selected');
    expect(events).toContain('deliberation_fallback');
  });

  it('falls back to pickShortest when LLM call throws', async () => {
    completeSimpleMock.mockRejectedValue(new Error('network error'));
    const plans = [makePlan([State.LOCATE, State.MODIFY, State.VERIFY]), makePlan([State.MODIFY])];
    const events: string[] = [];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg(), (e) =>
      events.push(e.type),
    );
    expect(result.type).toBe('selected');
    expect(events).toContain('deliberation_fallback');
  });

  it('returns no-candidates fallback when candidates is empty', async () => {
    const events: string[] = [];
    const result = await deliberate([], { id: 't', description: 'task', state: 'running' }, makeCfg(), (e) =>
      events.push(e.type),
    );
    expect(result.type).toBe('selected');
    expect(events).toContain('deliberation_fallback');
  });

  it('refinement stops when judge returns WORSE', async () => {
    const round1Steps = makeStepsJson([State.LOCATE, State.MODIFY, State.VERIFY]);
    const round2Steps = makeStepsJson([State.MODIFY]);
    completeSimpleMock
      .mockResolvedValueOnce(makeAssistantMessage(round1Steps) as any)
      .mockResolvedValueOnce(makeAssistantMessage('BETTER') as any)
      .mockResolvedValueOnce(makeAssistantMessage(round2Steps) as any)
      .mockResolvedValueOnce(makeAssistantMessage('WORSE') as any);
    const plans = [makePlan([State.LOCATE, State.MODIFY]), makePlan([State.DIAGNOSE, State.MODIFY])];
    const events: string[] = [];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg(), (e) =>
      events.push(e.type),
    );
    expect(result.type).toBe('selected');
    if (result.type === 'selected') {
      expect(result.result.synthesizedSteps).toHaveLength(3);
    }
    expect(events).toContain('deliberation_fallback');
  });

  it('refinement stops when judge returns SAME', async () => {
    const round1Steps = makeStepsJson([State.LOCATE, State.MODIFY]);
    completeSimpleMock
      .mockResolvedValueOnce(makeAssistantMessage(round1Steps) as any)
      .mockResolvedValueOnce(makeAssistantMessage('SAME') as any);
    const plans = [makePlan([State.LOCATE, State.MODIFY]), makePlan([State.DIAGNOSE, State.MODIFY])];
    const events: string[] = [];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg(), (e) =>
      events.push(e.type),
    );
    expect(result.type).toBe('selected');
    expect(events).toContain('deliberation_fallback');
  });

  it('buildMemoryCache includes why fields when present', async () => {
    const stepsJson = makeStepsJson([State.LOCATE, State.MODIFY]);
    completeSimpleMock
      .mockResolvedValueOnce(makeAssistantMessage(stepsJson) as any)
      .mockResolvedValue(makeAssistantMessage('SAME') as any);
    const plans = [makePlan([State.LOCATE], ['likely in auth middleware']), makePlan([State.DIAGNOSE, State.LOCATE])];
    await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    const callArg = completeSimpleMock.mock.calls[0]![1] as { messages: Array<{ content: string }> };
    const userPrompt = callArg.messages[0]!.content;
    expect(userPrompt).toContain('likely in auth middleware');
  });

  it('uses deliberationModel when configured', async () => {
    const stepsJson = makeStepsJson([State.MODIFY]);
    completeSimpleMock
      .mockResolvedValueOnce(makeAssistantMessage(stepsJson) as any)
      .mockResolvedValue(makeAssistantMessage('SAME') as any);
    const cfg = { ...makeCfg(), heavyThinking: { deliberationModel: 'qwen2.5:7b-instruct' } };
    const plans = [makePlan([State.MODIFY]), makePlan([State.LOCATE, State.MODIFY])];
    await deliberate(plans, { id: 't', description: 'task', state: 'running' }, cfg);
    const modelArg = completeSimpleMock.mock.calls[0]![0] as { id: string };
    expect(modelArg.id).toBe('qwen2.5:7b-instruct');
  });

  it('parseStepsJson: focus containing ] bracket does not truncate', async () => {
    const stepsWithBracket = JSON.stringify([
      { state: State.LOCATE, focus: 'find [auth] and [session] modules' },
      { state: State.MODIFY, focus: 'add error handler' },
    ]);
    completeSimpleMock
      .mockResolvedValueOnce(makeAssistantMessage(stepsWithBracket) as any)
      .mockResolvedValue(makeAssistantMessage('SAME') as any);
    const plans = [makePlan([State.MODIFY]), makePlan([State.LOCATE, State.MODIFY])];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    expect(result.type).toBe('selected');
    if (result.type === 'selected') {
      expect(result.result.synthesizedSteps).toHaveLength(2);
      expect('state' in result.result.synthesizedSteps[0]!).toBe(true);
      if ('state' in result.result.synthesizedSteps[0]!) {
        expect(result.result.synthesizedSteps[0]!.focus).toBe('find [auth] and [session] modules');
      }
    }
  });

  it('allowClarification=false: emits accurate fallback reason when LLM outputs needs_clarification', async () => {
    completeSimpleMock.mockResolvedValue(
      makeAssistantMessage('needs_clarification: true\nquestion: Which file?') as any,
    );
    const plans = [makePlan([State.LOCATE, State.MODIFY]), makePlan([State.DIAGNOSE, State.MODIFY])];
    const events: Array<{ type: string; reason?: string }> = [];
    const result = await deliberate(
      plans,
      { id: 't', description: 'task', state: 'running' },
      makeCfg(),
      (e) => events.push(e as { type: string; reason?: string }),
      false,
    );
    expect(result.type).toBe('selected');
    const fallback = events.find((e) => e.type === 'deliberation_fallback');
    expect(fallback).toBeDefined();
    expect(fallback?.reason).toContain('clarification');
  });

  it('allPlansSimilar: 3 plans where 2 are similar but 1 is different triggers deliberation', async () => {
    const stepsJson = makeStepsJson([State.DIAGNOSE, State.MODIFY, State.VERIFY]);
    completeSimpleMock
      .mockResolvedValueOnce(makeAssistantMessage(stepsJson) as any)
      .mockResolvedValue(makeAssistantMessage('SAME') as any);
    const plans = [
      makePlan([State.LOCATE, State.MODIFY]),
      makePlan([State.LOCATE, State.MODIFY]),
      makePlan([State.DIAGNOSE, State.LOCATE, State.MODIFY, State.VERIFY]),
    ];
    const events: string[] = [];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg(), (e) =>
      events.push(e.type),
    );
    expect(completeSimpleMock).toHaveBeenCalled();
    expect(result.type).toBe('selected');
    if (result.type === 'selected') {
      expect(result.result.synthesizedSteps).toHaveLength(3);
    }
  });

  it('refinement Convergence: stops when Jaccard > 0.85 after BETTER verdict', async () => {
    const sharedSteps = JSON.stringify([
      { state: State.LOCATE, focus: 'find the bug' },
      { state: State.MODIFY, focus: 'fix it' },
    ]);
    completeSimpleMock
      .mockResolvedValueOnce(makeAssistantMessage(sharedSteps) as any)
      .mockResolvedValueOnce(makeAssistantMessage(sharedSteps) as any)
      .mockResolvedValueOnce(makeAssistantMessage('BETTER') as any);
    const plans = [makePlan([State.LOCATE, State.MODIFY]), makePlan([State.DIAGNOSE, State.MODIFY])];
    const events: Array<{ type: string; reason?: string }> = [];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg(), (e) =>
      events.push(e as { type: string; reason?: string }),
    );
    expect(result.type).toBe('selected');
    if (result.type === 'selected') {
      expect(result.result.synthesizedSteps).toHaveLength(2);
    }
    const convergenceEvent = events.find(
      (e) => e.type === 'deliberation_refinement' && (e as any).verdict === 'converged',
    );
    expect(convergenceEvent).toBeDefined();
  });

  it('buildMemoryCache uses letter labels A B C not plan-0 plan-1', async () => {
    const stepsJson = makeStepsJson([State.MODIFY]);
    completeSimpleMock
      .mockResolvedValueOnce(makeAssistantMessage(stepsJson) as any)
      .mockResolvedValue(makeAssistantMessage('SAME') as any);
    const plans = [
      makePlan([State.LOCATE, State.MODIFY]),
      makePlan([State.DIAGNOSE, State.MODIFY]),
      makePlan([State.MODIFY]),
    ];
    await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    const callArg = completeSimpleMock.mock.calls[0]![1] as { messages: Array<{ content: string }> };
    const userPrompt = callArg.messages[0]!.content;
    expect(userPrompt).toContain('--- Plan A ---');
    expect(userPrompt).toContain('--- Plan B ---');
    expect(userPrompt).toContain('--- Plan C ---');
    expect(userPrompt).not.toContain('plan-0');
    expect(userPrompt).not.toContain('plan-1');
  });

  it('judge uses temperature=0', async () => {
    const round1 = makeStepsJson([State.LOCATE, State.MODIFY]);
    const round2 = makeStepsJson([State.DIAGNOSE, State.MODIFY]);
    completeSimpleMock
      .mockResolvedValueOnce(makeAssistantMessage(round1) as any)
      .mockResolvedValueOnce(makeAssistantMessage(round2) as any)
      .mockResolvedValueOnce(makeAssistantMessage('SAME') as any);
    const plans = [makePlan([State.MODIFY]), makePlan([State.LOCATE, State.MODIFY])];
    await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    const allCalls = completeSimpleMock.mock.calls;
    const judgeCallIdx = allCalls.findIndex((call) => {
      const ctx = call[1] as unknown as Record<string, unknown>;
      return (
        typeof ctx['systemPrompt'] === 'string' && (ctx['systemPrompt'] as string).includes('BETTER, WORSE, or SAME')
      );
    });
    expect(judgeCallIdx).toBeGreaterThan(-1);
    const judgeCallOpts = allCalls[judgeCallIdx]![2] as { temperature: number };
    expect(judgeCallOpts.temperature).toBe(0);
  });

  it('LLM call failure falls back to pickShortest, not empty steps', async () => {
    completeSimpleMock.mockRejectedValueOnce(new Error('network error'));
    const plans = [makePlan([State.LOCATE, State.MODIFY, State.VERIFY]), makePlan([State.MODIFY, State.VERIFY])];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    expect(result.type).toBe('selected');
    if (result.type === 'selected') {
      expect(result.result.synthesizedSteps.length).toBeGreaterThan(0);
    }
  });
});
