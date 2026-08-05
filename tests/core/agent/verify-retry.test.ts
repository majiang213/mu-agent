import { describe, it, expect, vi, beforeEach } from 'vitest';
import { State } from '../../../src/core/types.js';
import type { ExecutedStep, StepDirective } from '../../../src/core/types.js';

vi.mock('../../../src/core/agent/step-runner.js', () => ({
  runReasonStep: vi.fn(),
  executeSteps: vi.fn(async () => []),
  runStep: vi.fn(),
}));

// buildModels lives in provider/model-info.ts now (round-4 hygiene; Gap 89: returns {models, model}).
vi.mock('../../../src/provider/model-info.js', () => ({
  buildModels: vi.fn(async () => ({
    models: {},
    model: {
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
    },
  })),
  fetchOllamaParamCount: vi.fn(async () => null),
  fetchContextLength: vi.fn(async () => 128000),
  resolveApiKey: vi.fn(() => 'ollama'),
  OLLAMA_DUMMY_API_KEY: 'ollama',
}));

vi.mock('../../../src/core/agent/builder.js', () => ({
  buildStepAgent: vi.fn(),
  subscribeStepEvents: vi.fn(),
}));

vi.mock('../../../src/tool/safety/index.js', () => ({
  SafeModifier: vi.fn(function () {
    return {
      createCheckpoint: vi.fn(),
      restoreAndClearWhere: vi.fn(async () => {}),
      restore: vi.fn(),
      hasCheckpoint: vi.fn(() => false),
      clearCheckpoint: vi.fn(),
    };
  }),
}));

const { runReasonStep, executeSteps } = await import('../../../src/core/agent/step-runner.js');
const { runWithVerifyRetry } = await import('../../../src/core/agent/verify-retry.js');

function makeMission() {
  return { id: 'test-task', description: 'test task', state: 'running' as const };
}

function makeCfg() {
  return {
    model: {} as never,
    stateMachine: {
      getAllowedTools: vi.fn(() => []),
      getModelParams: vi.fn(() => ({
        tier: 'LARGE',
        maxRetries: 3,
        strictPlanning: false,
        maxFilesPerTask: 5,
        paramCount: 0,
      })),
    } as never,
    safetyConfig: {},
    locator: null,
    safeModifier: { createCheckpoint: vi.fn(), restoreAndClearWhere: vi.fn(async () => {}), restore: vi.fn() } as never,
    env: { cwd: '/tmp', platform: 'linux', isGitRepo: false, date: '2026-01-01' },
    temperature: 0.7,
    contextRatio: 0.2,
    apiKey: 'test',
    projectRoot: '/tmp',
    registerAgent: vi.fn(),
    unregisterAgent: vi.fn(),
  } as never;
}

const noopClarify = async (_questions: string[]) => 'ok';

describe('runWithVerifyRetry', () => {
  beforeEach(() => {
    vi.mocked(runReasonStep).mockReset();
    vi.mocked(executeSteps).mockReset();
  });

  it('S1: VERIFY passes → kind:completed with allStepResults', async () => {
    const verifyStep: ExecutedStep = {
      state: State.VERIFY,
      focus: 'run tests',
      output: JSON.stringify({ passed: true, issues: [], summary: 'all ok' }),
    };
    vi.mocked(executeSteps).mockResolvedValueOnce([verifyStep]);

    const outcome = await runWithVerifyRetry(
      [{ state: State.VERIFY, focus: 'run tests' } as StepDirective],
      makeMission(),
      [],
      makeCfg(),
      { onNeedsClarify: noopClarify },
    );

    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.allStepResults).toContainEqual(verifyStep);
      expect(outcome.mission.state).toBe('running');
    }
  });

  it('S2: VERIFY fails, retry returns empty steps → kind:failed', async () => {
    const verifyFail: ExecutedStep = {
      state: State.VERIFY,
      focus: 'run tests',
      output: JSON.stringify({ passed: false, issues: ['test failed'], summary: 'Tests failed' }),
    };
    vi.mocked(executeSteps).mockResolvedValueOnce([verifyFail]);
    vi.mocked(runReasonStep).mockResolvedValueOnce({ steps: [] });

    const outcome = await runWithVerifyRetry(
      [{ state: State.VERIFY, focus: 'run tests' } as StepDirective],
      makeMission(),
      [],
      makeCfg(),
      { onNeedsClarify: noopClarify },
    );

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.result.success).toBe(false);
      expect(outcome.result.output).toContain('retry produced no steps');
      expect(outcome.mission.state).toBe('failed');
    }
  });

  it('S3: VERIFY fails MAX_VERIFY_RETRIES+1 times → kind:failed after exhaustion', async () => {
    const verifyFail: ExecutedStep = {
      state: State.VERIFY,
      focus: 'run tests',
      output: JSON.stringify({ passed: false, issues: ['test failed'], summary: 'Tests failed' }),
    };

    vi.mocked(executeSteps)
      .mockResolvedValueOnce([verifyFail])
      .mockResolvedValueOnce([verifyFail])
      .mockResolvedValueOnce([verifyFail]);

    vi.mocked(runReasonStep)
      .mockResolvedValueOnce({ steps: [{ state: State.MODIFY, focus: 'fix attempt 1' }] })
      .mockResolvedValueOnce({ steps: [{ state: State.MODIFY, focus: 'fix attempt 2' }] });

    const outcome = await runWithVerifyRetry(
      [{ state: State.VERIFY, focus: 'run tests' } as StepDirective],
      makeMission(),
      [],
      makeCfg(),
      { onNeedsClarify: noopClarify },
    );

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.result.success).toBe(false);
      expect(outcome.result.output).toContain('verification retries');
      expect(outcome.mission.state).toBe('failed');
    }
  });
});
