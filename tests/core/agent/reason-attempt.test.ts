import { describe, it, expect, vi } from 'vitest';
import { State } from '../../../src/core/types.js';
import type { RunConfig, StepAgentBuildInput } from '../../../src/core/agent/types.js';
import { runReasonAttempt } from '../../../src/core/agent/reason-runner.js';

/**
 * Round-5 candidate 5: runReasonAttempt builds and drives through the
 * StepAgentDriver seam (cfg.stepDriver), and its capture-and-validate tail
 * (captureRounds) aligns the A/B branches — a plan captured on the
 * missing-complete error round earns the same single repair chance as one
 * captured on the first drive.
 *
 * These tests need NO module mocks: the driver seam plus real
 * buildCompleteTool / parseDirectives / buildSystemPrompt carry the behavior.
 */

interface FakeAgent {
  prompt: ReturnType<typeof vi.fn>;
  steer: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

/** A driver fake: buildAgent records the input; the model is "played" by
 *  playModel, which receives the complete tool and the 1-based prompt count. */
function makeDriver(playModel: (tools: StepAgentBuildInput['tools'], promptCount: number) => Promise<void>): {
  driver: NonNullable<RunConfig['stepDriver']>;
  buildInputs: StepAgentBuildInput[];
  agents: FakeAgent[];
} {
  const buildInputs: StepAgentBuildInput[] = [];
  const agents: FakeAgent[] = [];
  const byAgent = new Map<FakeAgent, StepAgentBuildInput>();
  let promptCount = 0;
  return {
    buildInputs,
    agents,
    driver: {
      buildAgent: vi.fn((input: StepAgentBuildInput) => {
        buildInputs.push(input);
        const agent: FakeAgent = {
          prompt: vi.fn(async () => {
            promptCount++;
            await playModel(input.tools, promptCount);
          }),
          steer: vi.fn(),
          abort: vi.fn(),
        };
        byAgent.set(agent, input);
        agents.push(agent);
        return agent as never;
      }),
      // The initial drive does NOT play the model: the tail (captureRounds,
      // the real module function) is what these tests exercise.
      driveUntilComplete: vi.fn(async () => {}),
    },
  };
}

async function callComplete(tools: StepAgentBuildInput['tools'], args: Record<string, unknown>): Promise<void> {
  const completeTool = tools.find((t) => t.name === 'complete');
  await completeTool?.execute('id', args, {} as never);
}

function makeCfg(driver: RunConfig['stepDriver']): RunConfig {
  const stateMachine = {
    clone: vi.fn(),
    transitionTo: vi.fn(),
    resetFileBudget: vi.fn(),
    getModelParams: vi.fn(() => ({ tier: 'LARGE' as const, maxRetries: 1, strictPlanning: false, paramCount: 0 })),
  };
  return {
    model: {} as RunConfig['model'],
    models: {} as RunConfig['models'],
    stateMachine: stateMachine as unknown as RunConfig['stateMachine'],
    safetyConfig: {},
    locator: null,
    safeModifier: { restoreAndClearWhere: vi.fn(async () => {}) } as unknown as RunConfig['safeModifier'],
    env: { cwd: '/tmp', platform: 'linux', isGitRepo: false, date: '2026-01-01' },
    temperature: 0,
    contextRatio: 0.2,
    apiKey: 'test',
    projectRoot: '/tmp',
    registerAgent: vi.fn(),
    unregisterAgent: vi.fn(),
    stepDriver: driver,
  };
}

const mission = { id: 't1', description: 'plan something', state: 'running' as const };

describe('runReasonAttempt — StepAgentDriver seam (round-5)', () => {
  it('builds the REASON agent through cfg.stepDriver', async () => {
    const { driver, buildInputs } = makeDriver(async (tools) => {
      await callComplete(tools, { steps: [{ state: 'LOCATE', focus: 'find files' }], needsClarify: false });
    });
    const cfg = makeCfg(driver);

    // The initial (fake) drive plays the model immediately — capture happens
    // inside the fake driveUntilComplete? No: the fake drive does nothing;
    // instead the tail's validate accepts the pre-captured plan... so play
    // via the tail: driveUntilComplete fake is a no-op, captureRounds runs
    // runStepAgent → prompt #1 → the model captures a valid plan.
    const result = await runReasonAttempt(mission, cfg, [], {});

    expect(buildInputs).toHaveLength(1);
    expect(buildInputs[0]!.state).toBe(State.REASON);
    expect(buildInputs[0]!.tools.some((t) => t.name === 'complete')).toBe(true);
    expect(result.steps).toHaveLength(1);
  });

  it('A/B aligned: a plan captured on the error round earns one repair chance', async () => {
    const { driver, agents } = makeDriver(async (tools, n) => {
      if (n === 1) {
        // Error round: schema-valid but plan-invalid (unknown state name).
        await callComplete(tools, { steps: [{ state: 'NOPE', focus: 'x' }], needsClarify: false });
      } else if (n === 2) {
        // Repair round: valid plan.
        await callComplete(tools, { steps: [{ state: 'MODIFY', focus: 'fix' }], needsClarify: false });
      }
    });
    const cfg = makeCfg(driver);

    const result = await runReasonAttempt(mission, cfg, [], {});

    // Before the alignment, the error-round capture got NO repair chance and
    // the attempt ended with a parse error; now it redrives once and accepts.
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ state: State.MODIFY });
    // Exactly two drives: one error round + one repair round (budget holds).
    expect(agents[0]!.prompt).toHaveBeenCalledTimes(2);
  });

  it('never captured → one error round, then stop (no nudge loop)', async () => {
    const { driver, agents } = makeDriver(async () => {});
    const cfg = makeCfg(driver);

    await expect(runReasonAttempt(mission, cfg, [], { throwOnFailure: true })).rejects.toThrow('complete() not called');
    expect(agents[0]!.prompt).toHaveBeenCalledTimes(1);
  });

  it('invalid plan after the repair round still fails (one chance only)', async () => {
    const { driver, agents } = makeDriver(async (tools) => {
      await callComplete(tools, { steps: [{ state: 'NOPE', focus: 'x' }], needsClarify: false });
    });
    const cfg = makeCfg(driver);

    await expect(runReasonAttempt(mission, cfg, [], { throwOnFailure: true })).rejects.toThrow('bare sample');
    // Two captures, both invalid: repair happened once, no third drive.
    expect(agents[0]!.prompt).toHaveBeenCalledTimes(2);
  });
});
