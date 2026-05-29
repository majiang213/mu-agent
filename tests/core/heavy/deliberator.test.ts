import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deliberate, pickShortest } from '../../../src/core/heavy/deliberator.js';
import type { PlanCandidate } from '../../../src/core/heavy/types.js';
import { State } from '../../../src/core/types.js';
import type { RunConfig } from '../../../src/core/agent/types.js';

vi.mock('@mariozechner/pi-ai', () => ({
  completeSimple: vi.fn(),
}));

import { completeSimple } from '@mariozechner/pi-ai';

function makePlan(id: string, states: State[], whys?: string[]): PlanCandidate {
  return {
    id,
    steps: states.map((s, i) => ({
      state: s,
      focus: `step ${i}`,
      ...(whys?.[i] ? { why: whys[i] } : {}),
    })),
    sampledAt: 0,
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
  return {
    model: makeModel(),
    stateMachine: {} as RunConfig['stateMachine'],
    safetyConfig: {},
    safeModifier: {} as RunConfig['safeModifier'],
    env: {} as RunConfig['env'],
    temperature: 0.1,
    contextRatio: 0.75,
    apiKey: 'ollama',
    projectRoot: '/tmp',
  };
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
    const plans = [makePlan('plan-0', [State.LOCATE, State.MODIFY])];
    expect(pickShortest(plans).id).toBe('plan-0');
  });

  it('returns the candidate with fewer steps', () => {
    const plans = [makePlan('plan-0', [State.LOCATE, State.MODIFY, State.VERIFY]), makePlan('plan-1', [State.MODIFY])];
    expect(pickShortest(plans).id).toBe('plan-1');
  });

  it('returns the first when lengths are equal', () => {
    const plans = [
      makePlan('plan-0', [State.LOCATE, State.MODIFY]),
      makePlan('plan-1', [State.DIAGNOSE, State.VERIFY]),
    ];
    expect(pickShortest(plans).id).toBe('plan-0');
  });

  it('handles three candidates', () => {
    const plans = [
      makePlan('plan-0', [State.LOCATE, State.MODIFY, State.VERIFY]),
      makePlan('plan-1', [State.MODIFY, State.VERIFY]),
      makePlan('plan-2', [State.MODIFY]),
    ];
    expect(pickShortest(plans).id).toBe('plan-2');
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
    const plans = [makePlan('plan-0', [State.LOCATE, State.MODIFY])];
    const result = await deliberate(plans, { id: 't', description: 'fix bug', state: 'running' }, makeCfg());
    expect(result.type).toBe('selected');
    if (result.type === 'selected') {
      expect(result.result.synthesizedSteps).toEqual(plans[0]!.steps);
      expect(result.result.deliberationSummary).toBe('single candidate');
    }
  });

  it('skips deliberation and picks shortest when all plans are similar', async () => {
    const plans = [makePlan('plan-0', [State.LOCATE, State.MODIFY]), makePlan('plan-1', [State.LOCATE, State.MODIFY])];
    const events: string[] = [];
    const result = await deliberate(plans, { id: 't', description: 'fix bug', state: 'running' }, makeCfg(), (e) =>
      events.push(e.type),
    );
    expect(result.type).toBe('selected');
    expect(events).toContain('deliberation_fallback');
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it('synthesizes steps from JSON response', async () => {
    vi.mocked(completeSimple)
      .mockResolvedValueOnce(makeAssistantMessage(makeStepsJson([State.LOCATE, State.MODIFY, State.VERIFY])) as any)
      .mockResolvedValue(makeAssistantMessage('SAME') as any);
    const plans = [makePlan('plan-0', [State.MODIFY]), makePlan('plan-1', [State.LOCATE, State.MODIFY, State.VERIFY])];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    expect(result.type).toBe('selected');
    if (result.type === 'selected') {
      expect(result.result.synthesizedSteps).toHaveLength(3);
      expect(result.result.synthesizedSteps[0]!.state).toBe(State.LOCATE);
    }
  });

  it('preserves why field in synthesized steps', async () => {
    const stepsWithWhy = JSON.stringify([
      { state: State.LOCATE, focus: 'find the bug', why: 'error likely in auth layer' },
      { state: State.MODIFY, focus: 'fix it' },
    ]);
    vi.mocked(completeSimple)
      .mockResolvedValueOnce(makeAssistantMessage(stepsWithWhy) as any)
      .mockResolvedValue(makeAssistantMessage('SAME') as any);
    const plans = [makePlan('plan-0', [State.MODIFY]), makePlan('plan-1', [State.LOCATE, State.MODIFY])];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    expect(result.type).toBe('selected');
    if (result.type === 'selected') {
      expect(result.result.synthesizedSteps[0]!.why).toBe('error likely in auth layer');
      expect(result.result.synthesizedSteps[1]!.why).toBeUndefined();
    }
  });

  it('parses needs_clarification', async () => {
    vi.mocked(completeSimple).mockResolvedValue(
      makeAssistantMessage('needs_clarification: true\nquestion: Which file should be modified?') as any,
    );
    const plans = [
      makePlan('plan-0', [State.LOCATE, State.MODIFY]),
      makePlan('plan-1', [State.DIAGNOSE, State.MODIFY]),
    ];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    expect(result.type).toBe('needs_clarification');
    if (result.type === 'needs_clarification') {
      expect(result.question).toBe('Which file should be modified?');
    }
  });

  it('needs_clarification is ignored when allowClarification=false, falls back to pickShortest', async () => {
    vi.mocked(completeSimple).mockResolvedValue(
      makeAssistantMessage('needs_clarification: true\nquestion: Which file?') as any,
    );
    const plans = [
      makePlan('plan-0', [State.LOCATE, State.MODIFY]),
      makePlan('plan-1', [State.DIAGNOSE, State.MODIFY]),
    ];
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
    vi.mocked(completeSimple).mockResolvedValue(makeAssistantMessage('I cannot decide.') as any);
    const plans = [makePlan('plan-0', [State.MODIFY]), makePlan('plan-1', [State.LOCATE, State.MODIFY])];
    const events: string[] = [];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg(), (e) =>
      events.push(e.type),
    );
    expect(result.type).toBe('selected');
    expect(events).toContain('deliberation_fallback');
  });

  it('falls back to pickShortest when LLM call throws', async () => {
    vi.mocked(completeSimple).mockRejectedValue(new Error('network error'));
    const plans = [makePlan('plan-0', [State.LOCATE, State.MODIFY, State.VERIFY]), makePlan('plan-1', [State.MODIFY])];
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
    vi.mocked(completeSimple)
      .mockResolvedValueOnce(makeAssistantMessage(round1Steps) as any)
      .mockResolvedValueOnce(makeAssistantMessage('BETTER') as any)
      .mockResolvedValueOnce(makeAssistantMessage(round2Steps) as any)
      .mockResolvedValueOnce(makeAssistantMessage('WORSE') as any);
    const plans = [
      makePlan('plan-0', [State.LOCATE, State.MODIFY]),
      makePlan('plan-1', [State.DIAGNOSE, State.MODIFY]),
    ];
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
    vi.mocked(completeSimple)
      .mockResolvedValueOnce(makeAssistantMessage(round1Steps) as any)
      .mockResolvedValueOnce(makeAssistantMessage('SAME') as any);
    const plans = [
      makePlan('plan-0', [State.LOCATE, State.MODIFY]),
      makePlan('plan-1', [State.DIAGNOSE, State.MODIFY]),
    ];
    const events: string[] = [];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg(), (e) =>
      events.push(e.type),
    );
    expect(result.type).toBe('selected');
    expect(events).toContain('deliberation_fallback');
  });

  it('buildMemoryCache includes why fields when present', async () => {
    const stepsJson = makeStepsJson([State.LOCATE, State.MODIFY]);
    vi.mocked(completeSimple)
      .mockResolvedValueOnce(makeAssistantMessage(stepsJson) as any)
      .mockResolvedValue(makeAssistantMessage('SAME') as any);
    const plans = [
      makePlan('plan-0', [State.LOCATE], ['likely in auth middleware']),
      makePlan('plan-1', [State.DIAGNOSE, State.LOCATE]),
    ];
    await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    const callArg = vi.mocked(completeSimple).mock.calls[0]![1] as { messages: Array<{ content: string }> };
    const userPrompt = callArg.messages[0]!.content;
    expect(userPrompt).toContain('likely in auth middleware');
  });

  it('uses deliberationModel when configured', async () => {
    const stepsJson = makeStepsJson([State.MODIFY]);
    vi.mocked(completeSimple)
      .mockResolvedValueOnce(makeAssistantMessage(stepsJson) as any)
      .mockResolvedValue(makeAssistantMessage('SAME') as any);
    const cfg = { ...makeCfg(), heavyThinking: { deliberationModel: 'qwen2.5:7b-instruct' } };
    const plans = [makePlan('plan-0', [State.MODIFY]), makePlan('plan-1', [State.LOCATE, State.MODIFY])];
    await deliberate(plans, { id: 't', description: 'task', state: 'running' }, cfg);
    const modelArg = vi.mocked(completeSimple).mock.calls[0]![0] as { id: string };
    expect(modelArg.id).toBe('qwen2.5:7b-instruct');
  });

  it('parseStepsJson: focus containing ] bracket does not truncate', async () => {
    const stepsWithBracket = JSON.stringify([
      { state: State.LOCATE, focus: 'find [auth] and [session] modules' },
      { state: State.MODIFY, focus: 'add error handler' },
    ]);
    vi.mocked(completeSimple)
      .mockResolvedValueOnce(makeAssistantMessage(stepsWithBracket) as any)
      .mockResolvedValue(makeAssistantMessage('SAME') as any);
    const plans = [makePlan('plan-0', [State.MODIFY]), makePlan('plan-1', [State.LOCATE, State.MODIFY])];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    expect(result.type).toBe('selected');
    if (result.type === 'selected') {
      expect(result.result.synthesizedSteps).toHaveLength(2);
      expect(result.result.synthesizedSteps[0]!.focus).toBe('find [auth] and [session] modules');
    }
  });

  it('allowClarification=false: emits accurate fallback reason when LLM outputs needs_clarification', async () => {
    vi.mocked(completeSimple).mockResolvedValue(
      makeAssistantMessage('needs_clarification: true\nquestion: Which file?') as any,
    );
    const plans = [
      makePlan('plan-0', [State.LOCATE, State.MODIFY]),
      makePlan('plan-1', [State.DIAGNOSE, State.MODIFY]),
    ];
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
    expect(fallback?.reason).toContain('澄清');
  });

  it('allPlansSimilar: 3 plans where 2 are similar but 1 is different triggers deliberation', async () => {
    const stepsJson = makeStepsJson([State.DIAGNOSE, State.MODIFY, State.VERIFY]);
    vi.mocked(completeSimple)
      .mockResolvedValueOnce(makeAssistantMessage(stepsJson) as any)
      .mockResolvedValue(makeAssistantMessage('SAME') as any);
    const plans = [
      makePlan('plan-0', [State.LOCATE, State.MODIFY]),
      makePlan('plan-1', [State.LOCATE, State.MODIFY]),
      makePlan('plan-2', [State.DIAGNOSE, State.LOCATE, State.MODIFY, State.VERIFY]),
    ];
    const events: string[] = [];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg(), (e) =>
      events.push(e.type),
    );
    expect(completeSimple).toHaveBeenCalled();
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
    vi.mocked(completeSimple)
      .mockResolvedValueOnce(makeAssistantMessage(sharedSteps) as any)
      .mockResolvedValueOnce(makeAssistantMessage(sharedSteps) as any)
      .mockResolvedValueOnce(makeAssistantMessage('BETTER') as any);
    const plans = [
      makePlan('plan-0', [State.LOCATE, State.MODIFY]),
      makePlan('plan-1', [State.DIAGNOSE, State.MODIFY]),
    ];
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
    vi.mocked(completeSimple)
      .mockResolvedValueOnce(makeAssistantMessage(stepsJson) as any)
      .mockResolvedValue(makeAssistantMessage('SAME') as any);
    const plans = [
      makePlan('plan-0', [State.LOCATE, State.MODIFY]),
      makePlan('plan-1', [State.DIAGNOSE, State.MODIFY]),
      makePlan('plan-2', [State.MODIFY]),
    ];
    await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    const callArg = vi.mocked(completeSimple).mock.calls[0]![1] as { messages: Array<{ content: string }> };
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
    vi.mocked(completeSimple)
      .mockResolvedValueOnce(makeAssistantMessage(round1) as any)
      .mockResolvedValueOnce(makeAssistantMessage(round2) as any)
      .mockResolvedValueOnce(makeAssistantMessage('SAME') as any);
    const plans = [makePlan('plan-0', [State.MODIFY]), makePlan('plan-1', [State.LOCATE, State.MODIFY])];
    await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    const allCalls = vi.mocked(completeSimple).mock.calls;
    const judgeCallIdx = allCalls.findIndex((call) => {
      const ctx = call[1] as Record<string, unknown>;
      return (
        typeof ctx['systemPrompt'] === 'string' && (ctx['systemPrompt'] as string).includes('BETTER, WORSE, or SAME')
      );
    });
    expect(judgeCallIdx).toBeGreaterThan(-1);
    const judgeCallOpts = allCalls[judgeCallIdx]![2] as { temperature: number };
    expect(judgeCallOpts.temperature).toBe(0);
  });

  it('LLM call failure falls back to pickShortest, not empty steps', async () => {
    vi.mocked(completeSimple).mockRejectedValueOnce(new Error('network error'));
    const plans = [
      makePlan('plan-0', [State.LOCATE, State.MODIFY, State.VERIFY]),
      makePlan('plan-1', [State.MODIFY, State.VERIFY]),
    ];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    expect(result.type).toBe('selected');
    if (result.type === 'selected') {
      expect(result.result.synthesizedSteps.length).toBeGreaterThan(0);
    }
  });
});
