import { describe, it, expect, vi } from 'vitest';
import type { RunConfig } from '../../../src/core/agent/types.js';
import type { AgentRegistryHooks, RunSetup, RunSetupFactory } from '../../../src/core/agent/setup.js';
import { ReactAgent } from '../../../src/core/agent/index.js';
import { makeRunConfig } from '../../helpers/run-config.js';
import { makeScriptedDriver, type ScriptEntry } from '../../helpers/scripted-driver.js';

/**
 * Facade tests drive ReactAgent.run() through TWO seams:
 * - the RunSetupFactory seam (round-5, candidate 1) — a fake RunSetup that
 *   replaces the assembly layer's import fan-out;
 * - the StepAgentDriver seam (round-8, candidate 2) — a scripted driver that
 *   plays the model through the real complete() tool, replacing the
 *   step-runner.js module mock. The whole pipeline (REASON → executeSteps →
 *   verify-retry → fixed ANSWER) runs production code.
 */

// ---- helpers ----

function makeCfg(hooks: AgentRegistryHooks, driver: RunConfig['stepDriver']): RunConfig {
  return makeRunConfig({
    registerAgent: hooks.registerAgent,
    unregisterAgent: hooks.unregisterAgent,
    temperature: 0.7,
    stepDriver: driver,
  });
}

interface FakeSetup {
  factory: RunSetupFactory;
  setup: RunSetup;
}

/** A RunSetup whose subsystems are all stubs; cfg carries the scripted driver. */
function makeFakeSetup(script: ScriptEntry[]): FakeSetup {
  const { driver } = makeScriptedDriver(script);
  const setup: RunSetup = {
    cfg: null as unknown as RunConfig, // filled by the factory (needs hooks)
    memoryStore: {
      writeEpisodeSync: vi.fn(),
      close: vi.fn(),
    } as unknown as RunSetup['memoryStore'],
    memoryIndex: '',
    memorySearchTool: {} as RunSetup['memorySearchTool'],
    pendingSummaries: Promise.resolve(),
    extensionErrors: [],
    close: vi.fn(),
  };
  const factory: RunSetupFactory = async (_config, _cwd, hooks) => {
    setup.cfg = makeCfg(hooks, driver);
    return setup;
  };
  return { factory, setup };
}

const config = {
  model: { name: 'test', provider: 'ollama' as const, baseUrl: 'http://localhost:11434' },
  safety: {},
};

const VERIFY_FAIL = { passed: false, issues: ['test failed'], summary: 'Tests failed' };
const MODIFY_OK = { edited: ['a.ts'], linesChanged: 1 };

// ---- Bug 5: abort() vs registerAgent race ----

describe('Bug 5: abort() vs registerAgent race window', () => {
  it('agents registered after abort() should be immediately aborted', () => {
    // Arrange: create a ReactAgent and simulate the race condition.
    const agent = new ReactAgent();

    // Create a mock agent for the parallel branch
    const lateAgent = { abort: vi.fn() };

    // Abort first (sets _aborted flag and clears internal set)
    agent.abort();

    // Now register a new agent after abort (simulates the race)
    // The public registerAgent method checks the _aborted flag.
    agent.registerAgent(lateAgent as never);

    // The agent should have been aborted immediately upon registration
    // because _aborted is true.
    expect(lateAgent.abort).toHaveBeenCalled();
  });
});

// ---- Bug 20: resource leak when REASON throws ----

describe('Bug 20: setup.close() runs even when runReasonStep throws', () => {
  it('disposes the run setup even when REASON fails', async () => {
    const { factory, setup } = makeFakeSetup([new Error('REASON failed')]);
    const agent = new ReactAgent(factory);

    // run() throws, but the finally block must dispose the setup — the fake
    // makes the assertion direct (previously inferred through a mocked
    // LspClient.dispose three modules away).
    await expect(agent.run('test task', config as never)).rejects.toThrow('REASON failed');
    expect(setup.close).toHaveBeenCalledOnce();
  });
});

// ---- Bug 21: VERIFY retry returning steps=[] is treated as success ----

describe('Bug 21: VERIFY retry with steps=[] misreported as success', () => {
  it('returns success:false when VERIFY fails and retry produces empty steps', async () => {
    const agent = new ReactAgent(
      makeFakeSetup([
        // REASON round 1: MODIFY + VERIFY; VERIFY reports failure.
        {
          steps: [
            { state: 'MODIFY', focus: 'fix code' },
            { state: 'VERIFY', focus: 'run tests' },
          ],
          needsClarify: false,
        },
        MODIFY_OK,
        VERIFY_FAIL,
        // Verify-retry REASON returns an empty plan.
        { steps: [], needsClarify: false },
      ]).factory,
    );

    const result = await agent.run('test task', config as never);

    // Bug 21: empty retry steps broke the loop and returned success:true.
    expect(result.success).toBe(false);
  });
});

// ---- Bug 22: retry plan without VERIFY returns success:true ----

describe('Bug 22: retry plan without VERIFY returns success:true', () => {
  it('returns success:false when retry plan has no VERIFY but previous VERIFY failed', async () => {
    const agent = new ReactAgent(
      makeFakeSetup([
        // Round 1: MODIFY + VERIFY, VERIFY fails.
        {
          steps: [
            { state: 'MODIFY', focus: 'fix code' },
            { state: 'VERIFY', focus: 'run tests' },
          ],
          needsClarify: false,
        },
        MODIFY_OK,
        VERIFY_FAIL,
        // Retry plan: ROLLBACK + MODIFY but NO VERIFY.
        {
          steps: [
            { state: 'ROLLBACK', focus: 'rollback' },
            { state: 'MODIFY', focus: 're-fix' },
          ],
          needsClarify: false,
        },
        { restored: ['a.ts'] },
        MODIFY_OK,
      ]).factory,
    );

    const result = await agent.run('test task', config as never);

    // Bug 22: no VERIFY in the retry round → lastVerify undefined → the loop
    // used to break and return success:true, forgetting the failed VERIFY.
    expect(result.success).toBe(false);
  });
});

// ---- Bug 25: conversationHistory append uses role:'user' for assistant ----

describe('Bug 25: conversationHistory assistant message uses wrong role', () => {
  it('runs REASON(steps=[]) → fixed ANSWER end to end and returns the answer', async () => {
    const agent = new ReactAgent(
      makeFakeSetup([{ steps: [], needsClarify: false }, { answer: 'The answer is 42' }]).factory,
    );

    const result = await agent.run('what is the answer?', config as never, undefined, []);

    // The run resolves through the real pipeline; the fixed ANSWER step's
    // complete() payload is the run output. (The role:'user' TUI half of
    // Bug 25 lives in the tui-bugs tests.)
    expect(result.success).toBe(true);
    expect(result.output).toContain('The answer is 42');
  });
});
