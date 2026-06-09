import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

// Mock pi-agent-core Agent to capture constructor options
vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: vi.fn(function (opts: Record<string, unknown>) {
    const self = { _opts: opts, subscribe: vi.fn(), abort: vi.fn(), steer: vi.fn() };
    return self;
  }),
}));

vi.mock('@earendil-works/pi-ai', () => ({
  streamSimple: vi.fn(async () => ({ content: [] })),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createCodingTools: vi.fn(() => []),
  createGrepTool: vi.fn(() => ({})),
  createLsTool: vi.fn(() => ({})),
  createFindTool: vi.fn(() => ({})),
}));

vi.mock('../../../src/tool/locator.js', () => ({ astLocatorTool: {} }));
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
  ContextCompactor: vi.fn(function () {
    return { compact: vi.fn((msgs: unknown) => ({ messages: msgs })) };
  }),
}));

const { buildStepAgent } = await import('../../../src/core/agent/builder.js');
const { Agent } = await import('@earendil-works/pi-agent-core');

function makeMinimalCfg(projectRoot: string) {
  return {
    model: {
      id: 'test',
      name: 'test',
      api: 'openai-completions',
      provider: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 100000,
    },
    stateMachine: {
      getModelParams: vi.fn(() => ({ tier: 'LARGE', maxRetries: 3, strictPlanning: false, maxFilesPerTask: 5 })),
      transitionTo: vi.fn(),
      recordToolCall: vi.fn(),
      canModifyMoreFiles: vi.fn(() => true),
    },
    safetyConfig: { enableCheckpoint: true },
    safeModifier: {
      createCheckpoint: vi.fn(async () => {}),
      hasCheckpoint: vi.fn(() => false),
      clearCheckpoint: vi.fn(),
      getCheckpoint: vi.fn(),
    },
    env: { cwd: projectRoot, platform: 'linux', isGitRepo: false, date: '2026-01-01' },
    temperature: 0.1,
    contextRatio: 0.75,
    apiKey: 'test',
    projectRoot,
    registerAgent: vi.fn(),
    unregisterAgent: vi.fn(),
    lspClient: undefined,
  } as never;
}

type BeforeToolCallFn = (ctx: { toolCall: { name: string }; args: unknown }) => Promise<unknown>;

function getCapturedBeforeToolCall(): BeforeToolCallFn {
  expect(vi.mocked(Agent)).toHaveBeenCalledOnce();
  const opts = vi.mocked(Agent).mock.calls[0][0] as { beforeToolCall?: BeforeToolCallFn };
  expect(opts.beforeToolCall).toBeDefined();
  return opts.beforeToolCall!;
}

// ---- Gap 67: createCheckpoint must receive absolute path ----

describe('Gap 67: createCheckpoint receives absolute path not relative', () => {
  beforeEach(() => {
    vi.mocked(Agent).mockClear();
  });

  it('passes absolute resolved path to createCheckpoint when filePath is relative', async () => {
    const projectRoot = '/tmp/test-project';
    const cfg = makeMinimalCfg(projectRoot);

    buildStepAgent('system prompt', [], cfg, undefined, []);

    const beforeToolCall = getCapturedBeforeToolCall();

    await beforeToolCall({
      toolCall: { name: 'edit' },
      args: { path: 'src/calc.js', oldText: 'foo', newText: 'bar' },
    });

    // Gap 67 fix: must be called with absolute resolved path
    expect(cfg.safeModifier.createCheckpoint).toHaveBeenCalledWith(join(projectRoot, 'src/calc.js'));
  });

  it('passes absolute path unchanged when filePath is already absolute', async () => {
    const projectRoot = '/tmp/test-project';
    const cfg = makeMinimalCfg(projectRoot);

    buildStepAgent('system prompt', [], cfg, undefined, []);

    const beforeToolCall = getCapturedBeforeToolCall();

    await beforeToolCall({
      toolCall: { name: 'write' },
      args: { path: '/tmp/test-project/calc.js', content: 'hello' },
    });

    expect(cfg.safeModifier.createCheckpoint).toHaveBeenCalledWith('/tmp/test-project/calc.js');
  });
});
