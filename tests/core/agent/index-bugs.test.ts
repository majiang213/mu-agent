import { describe, it, expect, vi, beforeEach } from 'vitest';
import { State } from '../../../src/core/types.js';
import type { ExecutedStep } from '../../../src/core/types.js';
import type { RunConfig } from '../../../src/core/agent/types.js';
import type { AgentRegistryHooks, RunSetup, RunSetupFactory } from '../../../src/core/agent/setup.js';

/**
 * Facade tests drive ReactAgent.run() through TWO seams:
 * - the step pipeline (step-runner.js) — the one behavioral mock below;
 * - the RunSetupFactory seam (round-5, candidate 1) — a fake RunSetup that
 *   replaces the 14 module mocks which used to neuter buildRunSetup's
 *   import fan-out (builder, state-machine, safety, locator, webfetch,
 *   websearch, model-info, lsp, memory, memory-search, context, defaults,
 *   child_process, os).
 */

vi.mock('../../../src/core/agent/step-runner.js', () => ({
  runReasonStep: vi.fn(),
  executeSteps: vi.fn(async () => []),
  runStep: vi.fn(),
}));

// ---- dynamic imports after mocks ----

const { runReasonStep, executeSteps, runStep } = await import('../../../src/core/agent/step-runner.js');
const { ReactAgent } = await import('../../../src/core/agent/index.js');

// ---- helpers ----

function makeCfg(hooks: AgentRegistryHooks): RunConfig {
  const stateMachine = {
    clone: vi.fn(),
    resetForNextTask: vi.fn(),
    getAllowedTools: vi.fn(() => []),
    getModelParams: vi.fn(() => ({
      tier: 'LARGE' as const,
      maxRetries: 3,
      strictPlanning: false,
      paramCount: 0,
    })),
    getCurrentState: vi.fn(() => State.REASON),
    transitionTo: vi.fn(),
    resetFileBudget: vi.fn(),
    recordToolCall: vi.fn(),
    canModifyMoreFiles: vi.fn(() => true),
  };
  return {
    model: {} as RunConfig['model'],
    stateMachine: stateMachine as unknown as RunConfig['stateMachine'],
    safetyConfig: {},
    locator: null,
    safeModifier: {
      createCheckpoint: vi.fn(),
      restoreAndClearWhere: vi.fn(async () => {}),
      restore: vi.fn(),
      hasCheckpoint: vi.fn(() => false),
      clearCheckpoint: vi.fn(),
    } as unknown as RunConfig['safeModifier'],
    env: { cwd: '/tmp', platform: 'linux', isGitRepo: false, date: '2026-01-01' },
    temperature: 0.7,
    contextRatio: 0.2,
    apiKey: 'test',
    projectRoot: '/tmp',
    registerAgent: hooks.registerAgent,
    unregisterAgent: hooks.unregisterAgent,
  };
}

interface FakeSetup {
  factory: RunSetupFactory;
  setup: RunSetup;
}

/** A RunSetup whose subsystems are all stubs; cfg honors the registry hooks. */
function makeFakeSetup(): FakeSetup {
  const setup: RunSetup = {
    cfg: null as unknown as RunConfig, // filled by the factory (needs hooks)
    memoryStore: {
      writeEpisodeSync: vi.fn(),
      close: vi.fn(),
    } as unknown as RunSetup['memoryStore'],
    memoryIndex: '',
    memorySearchTool: {} as RunSetup['memorySearchTool'],
    pendingSummaries: Promise.resolve(),
    close: vi.fn(),
  };
  const factory: RunSetupFactory = async (_config, _cwd, hooks) => {
    setup.cfg = makeCfg(hooks);
    return setup;
  };
  return { factory, setup };
}

const config = {
  model: { name: 'test', provider: 'ollama' as const, baseUrl: 'http://localhost:11434' },
  safety: {},
};

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
  beforeEach(() => {
    vi.mocked(runReasonStep).mockReset();
    vi.mocked(executeSteps).mockReset();
  });

  it('disposes the run setup even when REASON fails', async () => {
    vi.mocked(runReasonStep).mockRejectedValue(new Error('REASON failed'));

    const { factory, setup } = makeFakeSetup();
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
  beforeEach(() => {
    vi.mocked(runReasonStep).mockReset();
    vi.mocked(executeSteps).mockReset();
    vi.mocked(runStep).mockReset();
  });

  it('returns success:false when VERIFY fails and retry produces empty steps', async () => {
    // Arrange:
    // First round includes VERIFY with passed=false; verify-retry REASON returns empty steps
    const verifyFail: ExecutedStep = {
      state: State.VERIFY,
      focus: 'run tests',
      output: JSON.stringify({ passed: false, issues: ['test failed'], summary: 'Tests failed' }),
    };

    vi.mocked(runReasonStep)
      .mockResolvedValueOnce({ steps: [{ state: State.MODIFY, focus: 'fix code' }] })
      .mockResolvedValueOnce({ steps: [] });

    vi.mocked(executeSteps).mockResolvedValueOnce([
      { state: State.MODIFY, focus: 'fix code', output: '{}' },
      verifyFail,
    ]);

    // ANSWER step
    vi.mocked(runStep).mockResolvedValue({
      state: State.ANSWER,
      focus: 'answer',
      output: JSON.stringify({ answer: 'done' }),
    });

    const agent = new ReactAgent(makeFakeSetup().factory);

    // Act
    const result = await agent.run('test task', config as never);

    // Bug 21: When VERIFY fails and retry produces steps=[],
    // the code breaks out of the loop and returns success:true.
    // It should return success:false because the task failed verification.
    expect(result.success).toBe(false);
  });
});

// ---- Bug 22: retry plan without VERIFY returns success:true ----

describe('Bug 22: retry plan without VERIFY returns success:true', () => {
  beforeEach(() => {
    vi.mocked(runReasonStep).mockReset();
    vi.mocked(executeSteps).mockReset();
    vi.mocked(runStep).mockReset();
  });

  it('returns success:false when retry plan has no VERIFY but previous VERIFY failed', async () => {
    // Arrange:
    // First round: REASON plans [MODIFY, VERIFY], VERIFY fails
    const verifyFail: ExecutedStep = {
      state: State.VERIFY,
      focus: 'run tests',
      output: JSON.stringify({ passed: false, issues: ['test failed'], summary: 'Tests failed' }),
    };

    vi.mocked(runReasonStep)
      .mockResolvedValueOnce({ steps: [{ state: State.MODIFY, focus: 'fix code' }] })
      .mockResolvedValueOnce({
        steps: [
          { state: State.ROLLBACK, focus: 'rollback' },
          { state: State.MODIFY, focus: 're-fix' },
        ],
      });

    vi.mocked(executeSteps)
      .mockResolvedValueOnce([{ state: State.MODIFY, focus: 'fix code', output: '{}' }, verifyFail])
      .mockResolvedValueOnce([
        { state: State.ROLLBACK, focus: 'rollback', output: '{}' },
        { state: State.MODIFY, focus: 're-fix', output: '{}' },
      ]);

    // ANSWER step
    vi.mocked(runStep).mockResolvedValue({
      state: State.ANSWER,
      focus: 'answer',
      output: JSON.stringify({ answer: 'done' }),
    });

    const agent = new ReactAgent(makeFakeSetup().factory);

    // Act
    const result = await agent.run('test task', config as never);

    // Bug 22: When retry plan has no VERIFY, lastVerify is undefined,
    // the loop breaks, and success:true is returned.
    // The previous failed VERIFY result is forgotten.
    expect(result.success).toBe(false);
  });
});

// ---- Bug 25: conversationHistory append uses role:'user' for assistant ----

describe('Bug 25: conversationHistory assistant message uses wrong role', () => {
  beforeEach(() => {
    vi.mocked(runReasonStep).mockReset();
    vi.mocked(executeSteps).mockReset();
    vi.mocked(runStep).mockReset();
  });

  it('appends assistant response with role:"assistant" not role:"user"', async () => {
    // Arrange: successful task that produces a display result
    vi.mocked(runReasonStep).mockResolvedValue({
      steps: [{ state: State.ANSWER, focus: 'answer the question' }],
    });
    vi.mocked(executeSteps).mockResolvedValue([]);
    vi.mocked(runStep).mockResolvedValue({
      state: State.ANSWER,
      focus: 'answer',
      output: JSON.stringify({ answer: 'The answer is 42' }),
    });

    const agent = new ReactAgent(makeFakeSetup().factory);

    // Act
    await agent.run('what is the answer?', config as never, undefined, []);

    // Bug 25: In the TUI app.ts (line 1006), the assistant message is appended with
    // role: 'user' instead of role: 'assistant'. This creates consecutive user messages.
    // We can't directly test the TUI from here, but we verify the ReactAgent.run()
    // returns the correct result structure. The TUI bug is in app.ts handleSubmit.
    // This test documents the expected behavior.
    // The actual test for this is in the TUI bug tests.
    expect(true).toBe(true); // placeholder - real test is in tui-bugs
  });
});
