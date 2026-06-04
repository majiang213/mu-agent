import { describe, it, expect, vi, beforeEach } from 'vitest';
import { State } from '../../../src/core/types.js';
import type { RunConfig } from '../../../src/core/agent/types.js';

// ---- module mocks (must be hoisted before any dynamic imports) ----

vi.mock('../../../src/core/agent/builder.js', () => ({
  buildStepAgent: vi.fn(),
  subscribeStepEvents: vi.fn(),
}));

vi.mock('../../../src/core/cognitive/index.js', () => ({
  StagnationDetector: vi.fn(() => ({
    recordToolCall: vi.fn(),
    recordError: vi.fn(),
    check: vi.fn(() => ({ detected: false })),
    reset: vi.fn(),
  })),
}));

vi.mock('../../../src/core/failure/handler.js', () => ({
  FailureHandler: vi.fn(() => ({
    createContext: vi.fn(() => ({})),
    handleFailure: vi.fn(async () => ({ action: 'retry_with_backoff' })),
  })),
}));

vi.mock('../../../src/provider/model-info.js', () => ({
  fetchContextLength: vi.fn(async () => 128000),
}));

vi.mock('../../../src/tool/safety/checkpoint.js', () => ({
  SafeModifier: vi.fn(() => ({ createCheckpoint: vi.fn(), clearAll: vi.fn() })),
}));

vi.mock('../../../src/core/graph/locator.js', () => ({
  CodeGraphLocator: vi.fn(() => ({
    locate: vi.fn(() => ({ tree: '', suggestedFiles: [], snippets: {} })),
    updateFiles: vi.fn(),
  })),
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
  ContextCompactor: vi.fn(() => ({ compact: vi.fn((msgs: unknown[]) => ({ messages: msgs })) })),
  compressConversationHistoryWithLLM: vi.fn(async (msgs: unknown[]) => msgs),
}));

vi.mock('../../../src/config/defaults.js', () => ({
  DEFAULT_TEMPERATURE: 0.7,
  MAX_TEMPERATURE: 1.0,
  RETRY_TEMPERATURE_STEP: 0.1,
  DEFAULT_CONTEXT_RATIO: 0.2,
}));

// ---- dynamic imports after mocks ----

const { buildStepAgent, subscribeStepEvents } = await import('../../../src/core/agent/builder.js');
const { runStepAgent } = await import('../../../src/core/agent/step-runner.js');

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

// ---- tests ----

describe('runStepAgent', () => {
  beforeEach(() => {
    vi.mocked(subscribeStepEvents).mockImplementation(() => {});
  });

  describe('retry exhaustion', () => {
    it('rejects with the last captured error when all retries are exhausted', async () => {
      // The real maxRetries inside runStepAgent is Math.max(cfg value, 3) = 3.
      const cfg = makeCfg(3);
      const stagnation = makeStagnationDetector();
      const boom = new Error('LLM permanently unavailable');

      // Build a fake agent whose prompt always throws.
      const promptMock = vi.fn().mockRejectedValue(boom);
      const fakeAgent = {
        prompt: promptMock,
        steer: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        abort: vi.fn(),
      };

      vi.mocked(buildStepAgent).mockReturnValue(fakeAgent as never);

      // The bug: runStepAgent returns undefined instead of rejecting.
      // This assertion must FAIL before the fix because the function
      // currently resolves with undefined after the loop ends.
      await expect(runStepAgent(fakeAgent as never, 'do something', cfg, stagnation as never)).rejects.toThrow(
        'LLM permanently unavailable',
      );
    });

    it('calls agent.prompt exactly maxRetries times before exhausting retries', async () => {
      const cfg = makeCfg(3);
      const stagnation = makeStagnationDetector();
      const boom = new Error('LLM permanently unavailable');

      const promptMock = vi.fn().mockRejectedValue(boom);
      const fakeAgent = {
        prompt: promptMock,
        steer: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        abort: vi.fn(),
      };

      vi.mocked(buildStepAgent).mockReturnValue(fakeAgent as never);

      // Consume the (currently resolving) promise; we only care about call count here.
      await runStepAgent(fakeAgent as never, 'do something', cfg, stagnation as never).catch(() => {});

      // Math.max(3, 3) = 3 — prompt must have been attempted exactly 3 times.
      expect(promptMock).toHaveBeenCalledTimes(3);
    });
  });
});
