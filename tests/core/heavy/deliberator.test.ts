import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deliberate, pickShortest } from '../../../src/core/heavy/deliberator.js';
import type { PlanCandidate } from '../../../src/core/heavy/types.js';
import { State } from '../../../src/core/types.js';
import type { RunConfig } from '../../../src/core/agent/types.js';

vi.mock('@mariozechner/pi-ai', () => ({
  completeSimple: vi.fn(),
}));

import { completeSimple } from '@mariozechner/pi-ai';

function makePlan(id: string, states: State[]): PlanCandidate {
  return {
    id,
    steps: states.map((s, i) => ({ state: s, focus: `step ${i}` })),
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
    projectRoot: '/tmp',
  };
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
});

function makeAssistantMessage(text: string) {
  return { content: [{ type: 'text', text }] };
}

describe('deliberate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns selected when only one candidate', async () => {
    const plans = [makePlan('plan-0', [State.LOCATE, State.MODIFY])];
    const result = await deliberate(plans, { id: 't', description: 'fix bug', state: 'running' }, makeCfg());
    expect(result.type).toBe('selected');
    if (result.type === 'selected') {
      expect(result.result.selectedPlan.id).toBe('plan-0');
      expect(result.result.deliberationSummary).toBe('Single candidate');
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

  it('parses standard selected_plan_id format', async () => {
    vi.mocked(completeSimple).mockResolvedValue(
      makeAssistantMessage('selected_plan_id: plan-1\nreason: more complete\nrejected: plan-0: too simple') as any,
    );
    const plans = [makePlan('plan-0', [State.MODIFY]), makePlan('plan-1', [State.LOCATE, State.MODIFY, State.VERIFY])];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    expect(result.type).toBe('selected');
    if (result.type === 'selected') {
      expect(result.result.selectedPlan.id).toBe('plan-1');
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

  it('needs_clarification degrades to needs_plan_selection when allowClarification=false', async () => {
    vi.mocked(completeSimple).mockResolvedValue(
      makeAssistantMessage('needs_clarification: true\nquestion: Which file?') as any,
    );
    const plans = [
      makePlan('plan-0', [State.LOCATE, State.MODIFY]),
      makePlan('plan-1', [State.DIAGNOSE, State.MODIFY]),
    ];
    const result = await deliberate(
      plans,
      { id: 't', description: 'task', state: 'running' },
      makeCfg(),
      undefined,
      false,
    );
    expect(result.type).toBe('needs_plan_selection');
  });

  it('parses needs_plan_selection', async () => {
    vi.mocked(completeSimple).mockResolvedValue(
      makeAssistantMessage(
        'needs_plan_selection: true\nsummary_plan-0: direct modification\nsummary_plan-1: diagnose first',
      ) as any,
    );
    const plans = [makePlan('plan-0', [State.MODIFY]), makePlan('plan-1', [State.DIAGNOSE, State.MODIFY])];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    expect(result.type).toBe('needs_plan_selection');
    if (result.type === 'needs_plan_selection') {
      expect(result.candidates).toHaveLength(2);
      expect(result.summaries[0]).toBe('direct modification');
      expect(result.summaries[1]).toBe('diagnose first');
    }
  });

  it('falls back to text scanning when format is non-standard', async () => {
    vi.mocked(completeSimple).mockResolvedValue(
      makeAssistantMessage('I think plan-1 is better because it covers more cases.') as any,
    );
    const plans = [makePlan('plan-0', [State.MODIFY]), makePlan('plan-1', [State.LOCATE, State.MODIFY, State.VERIFY])];
    const events: string[] = [];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg(), (e) =>
      events.push(e.type),
    );
    expect(result.type).toBe('selected');
    expect(events).toContain('deliberation_fallback');
    if (result.type === 'selected') {
      expect(result.result.selectedPlan.id).toBe('plan-1');
    }
  });

  it('falls back to needs_plan_selection when parse completely fails', async () => {
    vi.mocked(completeSimple).mockResolvedValue(makeAssistantMessage('I cannot decide.') as any);
    const plans = [makePlan('plan-0', [State.MODIFY]), makePlan('plan-1', [State.LOCATE, State.MODIFY])];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg());
    expect(result.type).toBe('needs_plan_selection');
  });

  it('returns selected with fallback when LLM call throws', async () => {
    vi.mocked(completeSimple).mockRejectedValue(new Error('network error'));
    const plans = [makePlan('plan-0', [State.LOCATE, State.MODIFY, State.VERIFY]), makePlan('plan-1', [State.MODIFY])];
    const events: string[] = [];
    const result = await deliberate(plans, { id: 't', description: 'task', state: 'running' }, makeCfg(), (e) =>
      events.push(e.type),
    );
    expect(result.type).toBe('selected');
    expect(events).toContain('deliberation_fallback');
    if (result.type === 'selected') {
      expect(result.result.selectedPlan.id).toBe('plan-1');
    }
  });
});
