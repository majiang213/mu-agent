import { describe, it, expect, vi, beforeEach } from 'vitest';
import { State } from '../../../src/core/types.js';
import type { PlanCandidate } from '../../../src/core/heavy/types.js';

vi.mock('../../../src/core/agent/builder.js', () => ({
  buildStepAgent: vi.fn(() => ({ steer: vi.fn() })),
  subscribeStepEvents: vi.fn(),
}));

vi.mock('../../../src/core/cognitive/index.js', () => ({
  StagnationDetector: vi.fn(function () {
    return {
      recordToolCall: vi.fn(),
      recordError: vi.fn(),
      check: vi.fn(() => ({ detected: false })),
      reset: vi.fn(),
    };
  }),
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

vi.mock('../../../src/core/agent/step-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/agent/step-runner.js')>();
  return { ...actual, runStepAgent: vi.fn(async () => {}) };
});

vi.mock('../../../src/tool/safety/index.js', () => ({
  syntaxCheckHook: vi.fn(),
  damageCheckHook: vi.fn(),
  SafeModifier: vi.fn(() => ({ clearAll: vi.fn() })),
}));

import { samplePlans } from '../../../src/core/heavy/sampler.js';
import type { RunConfig, ExecutionEvent } from '../../../src/core/agent/types.js';

function makeStep(state: State) {
  return { state, focus: `focus ${state}` };
}

function makePlan(id: string, states: State[]): PlanCandidate {
  return { id, steps: states.map(makeStep), sampledAt: 0 };
}

function makeCfg(): RunConfig {
  return {
    model: { id: 'test-model', provider: 'ollama', baseUrl: 'http://localhost/v1' } as RunConfig['model'],
    stateMachine: {
      transitionTo: vi.fn(),
      clone: vi.fn(function () {
        return this;
      }),
      getModelParams: vi.fn(() => ({
        tier: 'SMALL',
        paramCount: 7,
        maxFilesPerTask: 2,
        maxRetries: 1,
        strictPlanning: true,
      })),
      getAllowedTools: vi.fn(() => []),
      getCurrentState: vi.fn(() => State.REASON),
      resetForRetry: vi.fn(),
      getStateConfig: vi.fn(() => ({ allowedTools: [], prompt: '' })),
      recordToolCall: vi.fn(),
      canModifyMoreFiles: vi.fn(() => true),
    } as unknown as RunConfig['stateMachine'],
    safetyConfig: {},
    safeModifier: {
      clearAll: vi.fn(),
      createCheckpoint: vi.fn(),
      hasCheckpoint: vi.fn(() => false),
      getCheckpoint: vi.fn(),
      clearCheckpoint: vi.fn(),
    } as unknown as RunConfig['safeModifier'],
    env: { cwd: '/tmp', platform: 'linux', isGitRepo: false, date: '2026-01-01' } as RunConfig['env'],
    temperature: 0.7,
    contextRatio: 0.75,
    apiKey: 'ollama',
    projectRoot: '/tmp',
    registerAgent: vi.fn(),
    unregisterAgent: vi.fn(),
  };
}

import { buildCompleteTool } from '../../../src/tool/complete.js';

describe('samplePlans — adaptive sampling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupCompleteMock(plans: PlanCandidate[]) {
    let callCount = 0;
    vi.mocked(buildCompleteTool).mockImplementation((_state, cb) => {
      const plan = plans[callCount % plans.length]!;
      callCount++;
      Promise.resolve().then(() => cb({ steps: plan.steps, needsClarify: false }));
      return { name: 'complete', execute: vi.fn() };
    });
  }

  it('returns seed candidate immediately when first batch all fail', async () => {
    const seed = makePlan('seed', [State.LOCATE, State.MODIFY, State.VERIFY]);
    vi.mocked(buildCompleteTool).mockImplementation(() => {
      throw new Error('agent build failed');
    });
    const cfg = makeCfg();
    const result = await samplePlans({ id: 't', description: 'fix', state: 'running' }, cfg, [], {}, undefined, [seed]);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('seed');
  });

  it('stops with converged when first batch all have same state sequence', async () => {
    const plan = makePlan('p', [State.LOCATE, State.MODIFY, State.VERIFY]);
    setupCompleteMock([plan, plan]);
    const cfg = makeCfg();
    const events: ExecutionEvent[] = [];
    const result = await samplePlans(
      { id: 't', description: 'fix', state: 'running' },
      cfg,
      [],
      {},
      (e) => events.push(e),
      [],
    );
    expect(events.some((e) => e.type === 'sampling_stopped' && e.reason === 'converged')).toBe(true);
    expect(result.length).toBe(1);
  });

  it('deduplicates candidates with same state sequence', async () => {
    const plan1 = makePlan('p1', [State.LOCATE, State.MODIFY]);
    const plan2 = makePlan('p2', [State.LOCATE, State.MODIFY]);
    setupCompleteMock([plan1, plan2]);
    const cfg = makeCfg();
    const result = await samplePlans({ id: 't', description: 'fix', state: 'running' }, cfg, [], {}, undefined, []);
    expect(result.length).toBe(1);
  });

  it('seed candidate with same seq as batch result is deduplicated', async () => {
    const seed = makePlan('seed', [State.LOCATE, State.MODIFY]);
    const plan = makePlan('p', [State.LOCATE, State.MODIFY]);
    setupCompleteMock([plan, plan]);
    const cfg = makeCfg();
    const result = await samplePlans({ id: 't', description: 'fix', state: 'running' }, cfg, [], {}, undefined, [seed]);
    expect(result.length).toBe(1);
  });

  it('fires sampling_stopped no_new_info when batch brings no new sequences', async () => {
    const seed = makePlan('seed', [State.LOCATE, State.MODIFY]);
    const same = makePlan('same', [State.LOCATE, State.MODIFY]);
    setupCompleteMock([same, same]);
    const cfg = makeCfg();
    const events: ExecutionEvent[] = [];
    await samplePlans({ id: 't', description: 'fix', state: 'running' }, cfg, [], {}, (e) => events.push(e), [seed]);
    expect(events.some((e) => e.type === 'sampling_stopped' && e.reason === 'no_new_info')).toBe(true);
  });

  it('fires sample_start with correct total', async () => {
    const plan = makePlan('p', [State.MODIFY]);
    setupCompleteMock([plan, plan]);
    const cfg = makeCfg();
    const events: ExecutionEvent[] = [];
    await samplePlans({ id: 't', description: 'fix', state: 'running' }, cfg, [], {}, (e) => events.push(e), []);
    const startEvents = events.filter((e) => e.type === 'sample_start');
    expect(startEvents.length).toBeGreaterThan(0);
    for (const e of startEvents) {
      if (e.type === 'sample_start') {
        expect(e.total).toBeGreaterThan(0);
        expect(e.total).not.toBe(-1);
      }
    }
  });
});
