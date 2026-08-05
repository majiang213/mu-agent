import { describe, it, expect, vi } from 'vitest';
import { State } from '../../../src/core/types.js';
import type { RunConfig } from '../../../src/core/agent/types.js';
import { makeRunConfig, makeStateMachineFake, makeStagnationFake } from '../../helpers/run-config.js';
import { driveUntilComplete, runStepAgent } from '../../../src/core/agent/reason-runner.js';
import { runStep } from '../../../src/core/agent/step-runner.js';

// ONE leaf mock (round-8, candidate 2): no-op sleep keeps retry paths fast.
// Everything else runs real — runStep is driven through the cfg.stepDriver
// seam (fake buildAgent returning the test's agent; the real
// driveUntilComplete where the exit protocol itself is under test), replacing
// the builder / git-guard / cognitive / model-info / checkpoint / locator /
// prompts / complete / compaction / defaults / heavy module mocks.

vi.mock('../../../src/core/failure/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/failure/index.js')>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});

// ---- helpers ----

function makeCfg(overrides: Partial<RunConfig> = {}): RunConfig {
  return makeRunConfig({
    stateMachine: makeStateMachineFake({ extraParams: { maxFilesPerTask: 5 } }),
    ...overrides,
  });
}

function makeFakeAgent(promptImpl?: ReturnType<typeof vi.fn>) {
  return {
    prompt: promptImpl ?? vi.fn(async () => {}),
    steer: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    abort: vi.fn(),
  };
}

// ---- Bug 2: runStepAgent retry mutates shared cfg.temperature ----

describe('Bug 2: cfg.temperature mutation on retry', () => {
  it('does not cross-contaminate temperature between two parallel cfg clones when one retries', async () => {
    // Arrange: two shallow clones of the same source cfg, as executeSteps does for parallel branches.
    const sourceCfg = makeCfg();
    sourceCfg.temperature = 0;

    const cloneA = { ...sourceCfg, stateMachine: sourceCfg.stateMachine };
    const cloneB = { ...sourceCfg, stateMachine: sourceCfg.stateMachine };

    const stagnationA = makeStagnationFake();
    const stagnationB = makeStagnationFake();

    // cloneA: throws once (attempt=0) then resolves.
    const promptA = vi
      .fn()
      .mockRejectedValueOnce(new Error('branch A transient error'))
      .mockResolvedValueOnce(undefined);
    // cloneB: succeeds immediately (no retry).
    const promptB = vi.fn().mockResolvedValueOnce(undefined);

    const fakeAgentA = makeFakeAgent(promptA);
    const fakeAgentB = makeFakeAgent(promptB);

    // Act: run both branches concurrently, mirroring executeSteps parallel dispatch.
    await Promise.all([
      runStepAgent(fakeAgentA as never, 'input', cloneA as never, stagnationA as never),
      runStepAgent(fakeAgentB as never, 'input', cloneB as never, stagnationB as never),
    ]);

    // Assert: cloneA's retry should NOT have mutated cloneB's temperature.
    expect(cloneB.temperature).toBe(0);
  });

  it('restores original temperature after all retries complete', async () => {
    const cfg = makeCfg();
    cfg.temperature = 0.5; // custom starting temperature
    const stagnation = makeStagnationFake();

    const promptMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce(undefined);

    const fakeAgent = makeFakeAgent(promptMock);

    await runStepAgent(fakeAgent as never, 'input', cfg, stagnation as never).catch(() => {});

    // After all retries, temperature must be restored to the original value.
    expect(cfg.temperature).toBe(0.5);
  });
});

// ---- Bug 3: REMINDER re-prompt passes empty string ----

describe('Bug 3: REMINDER re-prompt empty string', () => {
  it('passes a non-empty string to agent.prompt on REMINDER re-prompt during step execution', async () => {
    // The REAL exit protocol drives the fake agent: buildAgent is the only
    // fake half of the driver, so the reminder re-drive under test is the
    // production driveUntilComplete.
    const cfg = makeCfg();
    const promptMock = vi.fn().mockResolvedValue(undefined);
    const fakeAgent = makeFakeAgent(promptMock);
    cfg.stepDriver = {
      buildAgent: () => fakeAgent as never,
      driveUntilComplete,
    };

    const mission = { id: 'test-mission', description: 'fix the bug', state: 'running' as const };
    const step = { state: State.LOCATE, focus: 'find the bug location' };

    // Act — prompt() resolves without a complete() call, so the capture stays
    // empty and the driver re-prompts with the one REMINDER prompt.
    await runStep(step, 0, 1, mission, [], cfg);

    // Assert: prompt() should have been called at least twice.
    expect(promptMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Bug 3: the REMINDER re-prompt used to pass '' (empty string).
    const reminderCallArg = promptMock.mock.calls[1]![0] as string;
    expect(reminderCallArg).not.toBe('');
    expect(reminderCallArg.length).toBeGreaterThan(0);
  });
});

// ---- Bug 4: state_change event hardcodes from: State.REASON ----

describe('Bug 4: state_change event from field', () => {
  function makeNoopDriverCfg(currentState: State): RunConfig {
    const cfg = makeCfg();
    vi.mocked(cfg.stateMachine.getCurrentState).mockReturnValue(currentState);
    cfg.stepDriver = {
      buildAgent: () => makeFakeAgent() as never,
      driveUntilComplete: vi.fn(async () => {}),
    };
    return cfg;
  }

  it('emits state_change with from=MODIFY when current state is MODIFY, not hardcoded REASON', async () => {
    const cfg = makeNoopDriverCfg(State.MODIFY);
    const mission = { id: 'test-mission', description: 'fix the bug', state: 'running' as const };
    const step = { state: State.VERIFY, focus: 'run tests' };
    const events: Array<Record<string, unknown>> = [];
    const onEvent = (event: Record<string, unknown>) => events.push(event);

    await runStep(step, 1, 2, mission, [], cfg, { onEvent: onEvent as never });

    const stateChangeEvent = events.find((e) => e.type === 'state_change' && e.to === State.VERIFY);
    expect(stateChangeEvent).toBeDefined();
    expect(stateChangeEvent!.from).toBe(State.MODIFY);
  });

  it('emits state_change with from=LOCATE when current state is LOCATE', async () => {
    const cfg = makeNoopDriverCfg(State.LOCATE);
    const mission = { id: 'm1', description: 'task', state: 'running' as const };
    const step = { state: State.MODIFY, focus: 'edit code' };
    const events: Array<Record<string, unknown>> = [];
    const onEvent = (event: Record<string, unknown>) => events.push(event);

    await runStep(step, 0, 1, mission, [], cfg, { onEvent: onEvent as never });

    const stateChangeEvent = events.find((e) => e.type === 'state_change' && e.to === State.MODIFY);
    expect(stateChangeEvent).toBeDefined();
    expect(stateChangeEvent!.from).toBe(State.LOCATE);
  });
});
