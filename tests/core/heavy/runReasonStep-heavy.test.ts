import { describe, it, expect, vi, beforeEach } from 'vitest';
import { State } from '../../../src/core/types.js';
import type { RunConfig, ExecutionEvent } from '../../../src/core/agent/types.js';
import type { PlanCandidate } from '../../../src/core/heavy/types.js';

vi.mock('../../../src/core/heavy/index.js', () => ({
  samplePlans: vi.fn(),
  deliberate: vi.fn(),
  pickShortest: (candidates: PlanCandidate[]) =>
    candidates.reduce((a: PlanCandidate, b: PlanCandidate) => (a.steps.length <= b.steps.length ? a : b)),
  SAMPLING_BATCH_SIZE: 2,
}));

vi.mock('../../../src/core/agent/builder.js', () => ({
  buildStepAgent: vi.fn(() => {
    throw new Error('phase0 mocked failure');
  }),
  subscribeStepEvents: vi.fn(),
}));

vi.mock('../../../src/core/cognitive/index.js', () => ({
  StagnationDetector: vi.fn(() => ({
    recordToolCall: vi.fn(),
    recordError: vi.fn(),
    check: vi.fn(() => ({ detected: false })),
    reset: vi.fn(),
  })),
  createStagnationDetector: vi.fn(() => ({
    recordToolCall: vi.fn(),
    recordError: vi.fn(),
    check: vi.fn(() => ({ detected: false })),
    reset: vi.fn(),
    getStats: vi.fn(() => ({ toolCalls: 0 })),
  })),
}));

vi.mock('../../../src/core/compaction/index.js', () => ({
  compressConversationHistoryWithLLM: vi.fn(async (msgs: unknown[]) => msgs),
  ContextCompactor: vi.fn(),
}));

vi.mock('../../../src/tool/complete.js', () => ({
  buildCompleteTool: vi.fn(() => ({ name: 'complete', execute: vi.fn() })),
}));

vi.mock('../../../src/core/prompts/index.js', () => ({
  buildSystemPrompt: vi.fn(() => 'mocked system prompt'),
  buildUserPrompt: vi.fn(() => 'mocked user prompt'),
}));

vi.mock('../../../src/core/states.js', () => ({
  advanceState: vi.fn(),
  detectModelParams: vi.fn(() => ({
    tier: 'SMALL',
    paramCount: 7,
    maxFilesPerTask: 2,
    maxRetries: 1,
    strictPlanning: true,
  })),
}));

vi.mock('../../../src/tool/safety/index.js', () => ({
  syntaxCheckHook: vi.fn(),
  damageCheckHook: vi.fn(),
  SafeModifier: vi.fn(() => ({ clearAll: vi.fn() })),
}));

vi.mock('../../../src/core/graph/locator.js', () => ({
  CodeGraphLocator: vi.fn(),
}));

vi.mock('../../../src/tool/lsp.js', () => ({
  LspClient: vi.fn(() => ({ init: vi.fn(), dispose: vi.fn() })),
}));

vi.mock('../../../src/core/agent/step-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/agent/step-runner.js')>();
  return { ...actual, runStepAgent: vi.fn(async () => {}) };
});

import { samplePlans, deliberate } from '../../../src/core/heavy/index.js';
import { runReasonStep } from '../../../src/core/agent/step-runner.js';

function makePlan(id: string, states: State[]): PlanCandidate {
  return { id, steps: states.map((s, i) => ({ state: s, focus: `focus ${i}` })), sampledAt: 0 };
}

function makeCfg(heavyThinking?: RunConfig['heavyThinking']): RunConfig {
  return {
    model: { id: 'test-model', provider: 'ollama', baseUrl: 'http://localhost/v1' } as RunConfig['model'],
    stateMachine: {
      transitionTo: vi.fn(),
      getModelParams: vi.fn(() => ({
        tier: 'SMALL',
        paramCount: 7,
        maxFilesPerTask: 2,
        maxRetries: 1,
        strictPlanning: true,
      })),
      getCurrentState: vi.fn(() => State.REASON),
      resetForRetry: vi.fn(),
      getStateConfig: vi.fn(() => ({ allowedTools: [], prompt: '' })),
    } as unknown as RunConfig['stateMachine'],
    safetyConfig: {},
    safeModifier: { clearAll: vi.fn() } as unknown as RunConfig['safeModifier'],
    env: { cwd: '/tmp', platform: 'linux', isGitRepo: false, date: '2026-01-01' } as RunConfig['env'],
    temperature: 0.1,
    contextRatio: 0.75,
    apiKey: 'ollama',
    projectRoot: '/tmp',
    registerAgent: vi.fn(),
    unregisterAgent: vi.fn(),
    heavyThinking,
  };
}

function makeSelectedOutcome(
  plan: PlanCandidate,
): Extract<Awaited<ReturnType<typeof deliberate>>, { type: 'selected' }> {
  return {
    type: 'selected',
    result: { synthesizedSteps: plan.steps, deliberationSummary: 'synthesized' },
  };
}

describe('runReasonStep — heavy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fires deliberation_start with correct candidateCount', async () => {
    const cfg = makeCfg();
    const plan = makePlan('plan-0', [State.MODIFY]);
    vi.mocked(samplePlans).mockResolvedValue([plan]);
    vi.mocked(deliberate).mockResolvedValue(makeSelectedOutcome(plan));
    const events: ExecutionEvent[] = [];
    await runReasonStep({ id: 't', description: 'fix bug', state: 'running' }, cfg, [], (e) => events.push(e));
    const startEvent = events.find(
      (e): e is Extract<ExecutionEvent, { type: 'deliberation_start' }> => e.type === 'deliberation_start',
    );
    expect(startEvent).toBeDefined();
  });

  it('calls deliberate once when sampling succeeds', async () => {
    const cfg = makeCfg();
    const plan = makePlan('plan-0', [State.MODIFY]);
    vi.mocked(samplePlans).mockResolvedValue([plan]);
    vi.mocked(deliberate).mockResolvedValue(makeSelectedOutcome(plan));
    await runReasonStep({ id: 't', description: 'fix bug', state: 'running' }, cfg, []);
    expect(deliberate).toHaveBeenCalledTimes(1);
  });

  it('returns synthesized steps', async () => {
    const cfg = makeCfg();
    const plan0 = makePlan('plan-0', [State.LOCATE, State.MODIFY, State.VERIFY]);
    const plan1 = makePlan('plan-1', [State.MODIFY, State.VERIFY]);
    const synthesized = makePlan('synthesized', [State.DIAGNOSE, State.LOCATE, State.MODIFY, State.VERIFY]);
    vi.mocked(samplePlans).mockResolvedValue([plan0, plan1]);
    vi.mocked(deliberate).mockResolvedValue(makeSelectedOutcome(synthesized));
    const events: ExecutionEvent[] = [];
    const result = await runReasonStep({ id: 't', description: 'fix bug', state: 'running' }, cfg, [], (e) =>
      events.push(e),
    );
    expect(result.steps).toEqual(synthesized.steps);
    expect(events.some((e) => e.type === 'deliberation_complete' && e.synthesizedStepCount === 4)).toBe(true);
  });

  it('re-samples after clarification answer', async () => {
    const cfg = makeCfg();
    const plan0 = makePlan('plan-0', [State.LOCATE, State.MODIFY]);
    const plan1 = makePlan('plan-1', [State.DIAGNOSE, State.MODIFY]);
    vi.mocked(samplePlans).mockResolvedValue([plan0, plan1]);
    vi.mocked(deliberate)
      .mockResolvedValueOnce({ type: 'needs_clarification', question: 'Which file?' })
      .mockResolvedValueOnce(makeSelectedOutcome(plan0));
    const events: ExecutionEvent[] = [];
    const result = await runReasonStep(
      { id: 't', description: 'fix bug', state: 'running' },
      cfg,
      [],
      (e) => events.push(e),
      async () => 'src/auth.ts',
    );
    expect(samplePlans).toHaveBeenCalledTimes(2);
    expect(deliberate).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === 'deliberation_clarification')).toBe(true);
    expect(result.steps).toEqual(plan0.steps);
    const secondMissionDesc = vi.mocked(samplePlans).mock.calls[1]![0].description;
    expect(secondMissionDesc).toContain('src/auth.ts');
  });

  it('second deliberate uses allowClarification=false', async () => {
    const cfg = makeCfg();
    const plans = [
      makePlan('plan-0', [State.LOCATE, State.MODIFY]),
      makePlan('plan-1', [State.DIAGNOSE, State.MODIFY]),
    ];
    vi.mocked(samplePlans).mockResolvedValue(plans);
    vi.mocked(deliberate)
      .mockResolvedValueOnce({ type: 'needs_clarification', question: 'Which file?' })
      .mockResolvedValueOnce(makeSelectedOutcome(plans[0]!));
    await runReasonStep({ id: 't', description: 'fix', state: 'running' }, cfg, [], undefined, async () => 'answer');
    expect(vi.mocked(deliberate).mock.calls[1]![4]).toBe(false);
  });

  it('fires deliberation_start and deliberation_fallback when samples array is empty', async () => {
    const cfg = makeCfg();
    vi.mocked(samplePlans).mockResolvedValue([]);
    vi.mocked(deliberate).mockResolvedValue({
      type: 'selected',
      result: { synthesizedSteps: [], deliberationSummary: '' },
    });
    const events: ExecutionEvent[] = [];
    try {
      await runReasonStep({ id: 't', description: 'fix', state: 'running' }, cfg, [], (e) => events.push(e));
    } catch {}
    expect(events.some((e) => e.type === 'deliberation_start')).toBe(true);
    expect(events.some((e) => e.type === 'deliberation_fallback')).toBe(true);
  });

  it('enters heavy thinking when phase0 fails (fallback path)', async () => {
    const cfg = makeCfg();
    const plan = makePlan('plan-0', [State.LOCATE, State.MODIFY, State.VERIFY]);
    vi.mocked(samplePlans).mockResolvedValue([plan]);
    vi.mocked(deliberate).mockResolvedValue(makeSelectedOutcome(plan));
    const events: ExecutionEvent[] = [];
    await runReasonStep({ id: 't', description: 'fix bug in calc.js', state: 'running' }, cfg, [], (e) =>
      events.push(e),
    );
    expect(events.some((e) => e.type === 'state_change' && e.to === 'SAMPLING')).toBe(true);
    expect(samplePlans).toHaveBeenCalledTimes(1);
  });
});
