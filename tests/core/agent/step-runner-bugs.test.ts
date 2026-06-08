import { describe, it, expect, vi, beforeEach } from 'vitest';
import { State } from '../../../src/core/types.js';
import type { RunConfig } from '../../../src/core/agent/types.js';

// ---- module mocks (must be hoisted before any dynamic imports) ----

vi.mock('../../../src/core/agent/builder.js', () => ({
  buildStepAgent: vi.fn(),
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

vi.mock('../../../src/core/failure/handler.js', () => ({
  FailureHandler: vi.fn(function () {
    return {
      createContext: vi.fn(() => ({})),
      handleFailure: vi.fn(async () => ({ action: 'retry_with_backoff' })),
    };
  }),
}));

vi.mock('../../../src/provider/model-info.js', () => ({
  fetchContextLength: vi.fn(async () => 128000),
}));

vi.mock('../../../src/tool/safety/checkpoint.js', () => ({
  SafeModifier: vi.fn(function () {
    return { createCheckpoint: vi.fn(), clearAll: vi.fn() };
  }),
}));

vi.mock('../../../src/core/graph/locator.js', () => ({
  CodeGraphLocator: vi.fn(function () {
    return {
      locate: vi.fn(() => ({ tree: '', suggestedFiles: [], snippets: {} })),
      updateFiles: vi.fn(),
    };
  }),
}));

vi.mock('../../../src/core/prompts/index.js', () => ({
  buildSystemPrompt: vi.fn(() => 'system'),
  buildUserPrompt: vi.fn(() => 'user'),
}));

vi.mock('../../../src/core/states.js', () => ({
  advanceState: vi.fn((_s: unknown, traj: State[]) => traj[traj.length - 1] ?? State.DONE),
}));

vi.mock('../../../src/tool/complete.js', () => ({
  buildCompleteTool: vi.fn(() => ({
    name: 'complete',
    label: 'Complete',
    description: '',
    parameters: {},
    execute: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
  })),
}));

vi.mock('../../../src/core/compaction/index.js', () => ({
  ContextCompactor: vi.fn(function () {
    return { compact: vi.fn((msgs: unknown[]) => ({ messages: msgs })) };
  }),
  compressConversationHistoryWithLLM: vi.fn(async (msgs: unknown[]) => msgs),
}));

vi.mock('../../../src/config/defaults.js', () => ({
  DEFAULT_TEMPERATURE: 0.7,
  MAX_TEMPERATURE: 1.0,
  RETRY_TEMPERATURE_STEP: 0.1,
  DEFAULT_CONTEXT_RATIO: 0.2,
}));

vi.mock('../../../src/core/heavy/index.js', () => ({
  samplePlans: vi.fn(async () => []),
  deliberate: vi.fn(async () => ({ type: 'fallback' })),
  pickShortest: vi.fn(() => ({ steps: [] })),
  SAMPLING_BATCH_SIZE: 3,
}));

// ---- dynamic imports after mocks ----

const { buildStepAgent, subscribeStepEvents } = await import('../../../src/core/agent/builder.js');
const { runStepAgent, runStep } = await import('../../../src/core/agent/step-runner.js');

// ---- helpers ----

function makeStagnationDetector() {
  return {
    recordToolCall: vi.fn(),
    recordError: vi.fn(),
    check: vi.fn(() => ({ detected: false })),
    reset: vi.fn(),
  };
}

function makeCfg(maxRetries = 3): RunConfig {
  const stateMachine = {
    clone: vi.fn(),
    resetForNextTask: vi.fn(),
    getAllowedTools: vi.fn(() => []),
    getModelParams: vi.fn(() => ({
      tier: 'LARGE' as const,
      maxRetries,
      strictPlanning: false,
      maxFilesPerTask: 5,
      paramCount: 0,
    })),
    getCurrentState: vi.fn(() => State.REASON),
    transitionTo: vi.fn(),
    resetForRetry: vi.fn(),
  };
  return {
    model: {} as RunConfig['model'],
    stateMachine: stateMachine as unknown as RunConfig['stateMachine'],
    safetyConfig: {},
    safeModifier: { createCheckpoint: vi.fn(), clearAll: vi.fn() } as unknown as RunConfig['safeModifier'],
    env: { cwd: '/tmp', platform: 'linux', isGitRepo: false, date: '2026-01-01' },
    temperature: 0,
    contextRatio: 0.2,
    apiKey: 'test',
    projectRoot: '/tmp',
    registerAgent: vi.fn(),
    unregisterAgent: vi.fn(),
  };
}

// ---- Bug 2: runStepAgent retry mutates shared cfg.temperature ----

describe('Bug 2: cfg.temperature mutation on retry', () => {
  beforeEach(() => {
    vi.mocked(subscribeStepEvents).mockImplementation(() => {});
  });

  it('does not cross-contaminate temperature between two parallel cfg clones when one retries', async () => {
    // Arrange: two shallow clones of the same source cfg, as executeSteps does for parallel branches.
    const sourceCfg = makeCfg(3);
    sourceCfg.temperature = 0;

    const cloneA = { ...sourceCfg, stateMachine: sourceCfg.stateMachine };
    const cloneB = { ...sourceCfg, stateMachine: sourceCfg.stateMachine };

    const stagnationA = makeStagnationDetector();
    const stagnationB = makeStagnationDetector();

    // cloneA: throws once (attempt=0) then resolves.
    const promptA = vi
      .fn()
      .mockRejectedValueOnce(new Error('branch A transient error'))
      .mockResolvedValueOnce(undefined);
    // cloneB: succeeds immediately (no retry).
    const promptB = vi.fn().mockResolvedValueOnce(undefined);

    const fakeAgentA = { prompt: promptA, steer: vi.fn(), on: vi.fn(), off: vi.fn(), abort: vi.fn() };
    const fakeAgentB = { prompt: promptB, steer: vi.fn(), on: vi.fn(), off: vi.fn(), abort: vi.fn() };

    // Act: run both branches concurrently, mirroring executeSteps parallel dispatch.
    await Promise.all([
      runStepAgent(fakeAgentA as never, 'input', cloneA as never, stagnationA as never),
      runStepAgent(fakeAgentB as never, 'input', cloneB as never, stagnationB as never),
    ]);

    // Assert: cloneA's retry should NOT have mutated cloneB's temperature.
    // The bug: cfg.temperature = Math.min(...) on line 174 mutates the shared object.
    // After cloneA retries, cloneB.temperature should still be 0 (unchanged).
    expect(cloneB.temperature).toBe(0);
  });

  it('restores original temperature after all retries complete', async () => {
    const cfg = makeCfg(3);
    cfg.temperature = 0.5; // custom starting temperature
    const stagnation = makeStagnationDetector();

    const promptMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce(undefined);

    const fakeAgent = { prompt: promptMock, steer: vi.fn(), on: vi.fn(), off: vi.fn(), abort: vi.fn() };

    await runStepAgent(fakeAgent as never, 'input', cfg, stagnation as never).catch(() => {});

    // After all retries, temperature must be restored to the original value.
    // The finally block (line 188) should restore it.
    expect(cfg.temperature).toBe(0.5);
  });
});

// ---- Bug 3: REMINDER re-prompt passes empty string ----

describe('Bug 3: REMINDER re-prompt empty string', () => {
  beforeEach(() => {
    vi.mocked(subscribeStepEvents).mockImplementation(() => {});
  });

  it('passes a non-empty string to agent.prompt on REMINDER re-prompt during step execution', async () => {
    // Arrange: runStep is called for a LOCATE step.
    // prompt() resolves immediately without invoking complete(), so capturedComplete stays null.
    const cfg = makeCfg(3);
    const promptMock = vi.fn().mockResolvedValue(undefined);
    const fakeAgent = {
      prompt: promptMock,
      steer: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      abort: vi.fn(),
    };

    vi.mocked(buildStepAgent).mockReturnValue(fakeAgent as never);

    const mission = { id: 'test-mission', description: 'fix the bug', state: 'pending' as const };
    const step = { state: State.LOCATE, focus: 'find the bug location' };

    // Act
    await runStep(step, 0, 1, mission, [], cfg);

    // Assert: prompt() should have been called at least twice.
    expect(promptMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Bug 3: the REMINDER re-prompt currently passes '' (empty string).
    // After fix, it should pass a meaningful non-empty string.
    const reminderCallArg = promptMock.mock.calls[1]![0] as string;
    expect(reminderCallArg).not.toBe('');
    expect(reminderCallArg.length).toBeGreaterThan(0);
  });
});

// ---- Bug 4: state_change event hardcodes from: State.REASON ----

describe('Bug 4: state_change event from field', () => {
  beforeEach(() => {
    vi.mocked(subscribeStepEvents).mockImplementation(() => {});
  });

  it('emits state_change with from=MODIFY when current state is MODIFY, not hardcoded REASON', async () => {
    // Arrange: simulate a step where the state machine is already in MODIFY state.
    // This happens when runStep is called for the VERIFY step after a MODIFY step.
    const cfg = makeCfg(3);
    vi.mocked(cfg.stateMachine.getCurrentState).mockReturnValue(State.MODIFY);

    const promptMock = vi.fn().mockResolvedValue(undefined);
    const fakeAgent = {
      prompt: promptMock,
      steer: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      abort: vi.fn(),
    };
    vi.mocked(buildStepAgent).mockReturnValue(fakeAgent as never);

    const mission = { id: 'test-mission', description: 'fix the bug', state: 'pending' as const };
    const step = { state: State.VERIFY, focus: 'run tests' };

    // Capture onEvent calls
    const events: Array<Record<string, unknown>> = [];
    const onEvent = (event: Record<string, unknown>) => events.push(event);

    // Act
    await runStep(step, 1, 2, mission, [], cfg, onEvent);

    // Assert: the state_change event should have from=MODIFY (the actual current state),
    // not from=REASON (which is hardcoded on line 514/523 of step-runner.ts).
    const stateChangeEvent = events.find((e) => e.type === 'state_change' && e.to === State.VERIFY);
    expect(stateChangeEvent).toBeDefined();
    // Bug 4: line 514 hardcodes from: State.REASON for all steps.
    // After fix, from should be the actual state (MODIFY).
    expect(stateChangeEvent!.from).toBe(State.MODIFY);
  });

  it('emits state_change with from=LOCATE when current state is LOCATE', async () => {
    const cfg = makeCfg(3);
    vi.mocked(cfg.stateMachine.getCurrentState).mockReturnValue(State.LOCATE);

    const promptMock = vi.fn().mockResolvedValue(undefined);
    const fakeAgent = { prompt: promptMock, steer: vi.fn(), on: vi.fn(), off: vi.fn(), abort: vi.fn() };
    vi.mocked(buildStepAgent).mockReturnValue(fakeAgent as never);

    const mission = { id: 'm1', description: 'task', state: 'pending' as const };
    const step = { state: State.MODIFY, focus: 'edit code' };
    const events: Array<Record<string, unknown>> = [];
    const onEvent = (event: Record<string, unknown>) => events.push(event);

    await runStep(step, 0, 1, mission, [], cfg, onEvent);

    const stateChangeEvent = events.find((e) => e.type === 'state_change' && e.to === State.MODIFY);
    expect(stateChangeEvent).toBeDefined();
    expect(stateChangeEvent!.from).toBe(State.LOCATE);
  });
});
