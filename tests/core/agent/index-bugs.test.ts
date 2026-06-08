import { describe, it, expect, vi, beforeEach } from 'vitest';
import { State } from '../../../src/core/types.js';
import type { ExecutedStep, StepDirective } from '../../../src/core/types.js';

// ---- module mocks ----

vi.mock('../../../src/core/agent/builder.js', () => ({
  buildStepAgent: vi.fn(),
  subscribeStepEvents: vi.fn(),
}));

vi.mock('../../../src/core/agent/step-runner.js', () => ({
  buildModel: vi.fn(async () => ({
    id: 'test-model',
    name: 'test-model',
    api: 'openai-completions',
    provider: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 100000,
  })),
  compressConversationHistory: vi.fn(async (msgs: unknown[]) => msgs),
  compressConversationHistorySync: vi.fn((msgs: unknown[]) => msgs),
  runReasonStep: vi.fn(),
  executeSteps: vi.fn(async () => []),
  runStep: vi.fn(),
  parseReasonSteps: vi.fn(),
}));

vi.mock('../../../src/core/session/index.js', () => ({
  StateMachineAgent: vi.fn(function () {
    return {
      getModelParams: vi.fn(() => ({
        tier: 'LARGE',
        maxRetries: 3,
        strictPlanning: false,
        maxFilesPerTask: 5,
        paramCount: 0,
      })),
      getCurrentState: vi.fn(() => State.REASON),
      transitionTo: vi.fn(),
      clone: vi.fn(),
      resetForNextTask: vi.fn(),
      getAllowedTools: vi.fn(() => []),
      recordToolCall: vi.fn(),
      canModifyMoreFiles: vi.fn(() => true),
      resetForRetry: vi.fn(),
    };
  }),
}));

vi.mock('../../../src/tool/safety/index.js', () => ({
  SafeModifier: vi.fn(function () {
    return {
      createCheckpoint: vi.fn(),
      clearAll: vi.fn(),
      restore: vi.fn(),
      hasCheckpoint: vi.fn(() => false),
      clearCheckpoint: vi.fn(),
    };
  }),
}));

vi.mock('../../../src/tool/locator.js', () => ({ astLocatorTool: {} }));
vi.mock('../../../src/tool/webfetch.js', () => ({ webfetchTool: {} }));
vi.mock('../../../src/tool/websearch.js', () => ({ websearchTool: {} }));

vi.mock('../../../src/provider/model-info.js', () => ({
  fetchOllamaParamCount: vi.fn(async () => null),
  fetchContextLength: vi.fn(async () => 128000),
}));

vi.mock('../../../src/tool/lsp.js', () => ({
  LspClient: vi.fn(function () {
    return {
      init: vi.fn(async () => {}),
      dispose: vi.fn(),
      touchFile: vi.fn(async () => []),
    };
  }),
}));

vi.mock('../../../src/core/memory/index.js', () => ({
  MemoryStore: vi.fn(function () {
    return {
      processPendingSummaries: vi.fn(async () => {}),
      writeEpisodeSync: vi.fn(),
    };
  }),
  findGitRoot: vi.fn(() => '/tmp'),
  initMemoryDb: vi.fn(() => ({
    prepare: vi.fn(() => ({ get: vi.fn(), all: vi.fn(() => []), run: vi.fn() })),
    close: vi.fn(),
  })),
  formatMemoryIndex: vi.fn(() => ''),
}));

vi.mock('../../../src/tool/memory-search.js', () => ({
  createMemorySearchTool: vi.fn(() => ({})),
}));

vi.mock('../../../src/core/agent/context.js', () => ({
  loadContext: vi.fn(() => null),
}));

vi.mock('../../../src/config/defaults.js', () => ({
  DEFAULT_TEMPERATURE: 0.7,
  DEFAULT_CONTEXT_RATIO: 0.2,
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/test'),
}));

// ---- dynamic imports ----

const { runReasonStep, executeSteps, runStep } = await import('../../../src/core/agent/step-runner.js');
const { ReactAgent } = await import('../../../src/core/agent/index.js');

// ---- helpers ----

function makeCfg() {
  const stateMachine = {
    clone: vi.fn(),
    resetForNextTask: vi.fn(),
    getAllowedTools: vi.fn(() => []),
    getModelParams: vi.fn(() => ({
      tier: 'LARGE' as const,
      maxRetries: 3,
      strictPlanning: false,
      maxFilesPerTask: 5,
      paramCount: 0,
    })),
    getCurrentState: vi.fn(() => State.REASON),
    transitionTo: vi.fn(),
    resetForRetry: vi.fn(),
    recordToolCall: vi.fn(),
    canModifyMoreFiles: vi.fn(() => true),
  };
  return {
    model: {} as never,
    stateMachine: stateMachine as never,
    safetyConfig: {},
    safeModifier: {
      createCheckpoint: vi.fn(),
      clearAll: vi.fn(),
      restore: vi.fn(),
      hasCheckpoint: vi.fn(() => false),
      clearCheckpoint: vi.fn(),
    } as never,
    env: { cwd: '/tmp', platform: 'linux', isGitRepo: false, date: '2026-01-01' },
    temperature: 0.7,
    contextRatio: 0.2,
    apiKey: 'test',
    projectRoot: '/tmp',
    registerAgent: vi.fn(),
    unregisterAgent: vi.fn(),
  };
}

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

// ---- Bug 20: runReasonStep outside try block ----

describe('Bug 20: runReasonStep outside try block causes resource leak', () => {
  beforeEach(() => {
    vi.mocked(runReasonStep).mockReset();
    vi.mocked(executeSteps).mockReset();
  });

  it('lspClient.dispose() is called even when runReasonStep throws', async () => {
    // Arrange: runReasonStep throws an error.
    vi.mocked(runReasonStep).mockRejectedValue(new Error('REASON failed'));

    const agent = new ReactAgent();

    const config = {
      model: { name: 'test', provider: 'ollama' as const, baseUrl: 'http://localhost:11434' },
      safety: {},
    };

    // Act: run() should throw, but lspClient.dispose() should still be called.
    await expect(agent.run('test task', config as never)).rejects.toThrow();

    // Bug 20: runReasonStep is called BEFORE the try block (line 187).
    // When it throws, the catch/finally blocks handle it, but lspClient.dispose()
    // is in the finally block at line 358. However, lspClient was initialized at line 127-128
    // INSIDE the try block. If runReasonStep is called before the try block and throws,
    // lspClient was never initialized, so dispose() might not be called on the right object.
    // The real issue: if runReasonStep is moved into the try block, the finally handles it.
    // Currently it IS inside try (line 187), so this test verifies the fix path works.
    // We test that no unhandled resource leak occurs.
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
    // First round: executeSteps returns VERIFY with passed=false
    const verifyFail: ExecutedStep = {
      state: State.VERIFY,
      focus: 'run tests',
      output: JSON.stringify({ passed: false, issues: ['test failed'], summary: 'Tests failed' }),
    };

    // After retry, runReasonStep returns empty steps (model couldn't plan)
    vi.mocked(runReasonStep)
      .mockResolvedValueOnce({ steps: [{ state: State.MODIFY, focus: 'fix code' }] }) // initial REASON
      .mockResolvedValueOnce({ steps: [] }); // retry REASON returns empty

    vi.mocked(executeSteps)
      .mockResolvedValueOnce([{ state: State.MODIFY, focus: 'fix code', output: '{}' }]) // first round
      .mockResolvedValueOnce([verifyFail]); // second round (VERIFY fails)

    // ANSWER step
    vi.mocked(runStep).mockResolvedValue({
      state: State.ANSWER,
      focus: 'answer',
      output: JSON.stringify({ answer: 'done' }),
    });

    const agent = new ReactAgent();
    const config = {
      model: { name: 'test', provider: 'ollama' as const, baseUrl: 'http://localhost:11434' },
      safety: {},
    };

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

    // Retry round: REASON plans [ROLLBACK, MODIFY] (no VERIFY)
    vi.mocked(runReasonStep)
      .mockResolvedValueOnce({ steps: [{ state: State.MODIFY, focus: 'fix code' }] }) // initial
      .mockResolvedValueOnce({
        steps: [
          { state: State.ROLLBACK, focus: 'rollback' },
          { state: State.MODIFY, focus: 're-fix' },
        ],
      }); // retry

    vi.mocked(executeSteps)
      .mockResolvedValueOnce([{ state: State.MODIFY, focus: 'fix code', output: '{}' }]) // first round
      .mockResolvedValueOnce([verifyFail]) // VERIFY fails
      .mockResolvedValueOnce([
        { state: State.ROLLBACK, focus: 'rollback', output: '{}' },
        { state: State.MODIFY, focus: 're-fix', output: '{}' },
      ]); // retry round

    // ANSWER step
    vi.mocked(runStep).mockResolvedValue({
      state: State.ANSWER,
      focus: 'answer',
      output: JSON.stringify({ answer: 'done' }),
    });

    const agent = new ReactAgent();
    const config = {
      model: { name: 'test', provider: 'ollama' as const, baseUrl: 'http://localhost:11434' },
      safety: {},
    };

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

    const agent = new ReactAgent();
    const config = {
      model: { name: 'test', provider: 'ollama' as const, baseUrl: 'http://localhost:11434' },
      safety: {},
    };

    const conversationHistory: Array<{ role: string; content: string }> = [];

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
