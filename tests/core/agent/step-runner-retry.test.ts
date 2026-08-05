import { describe, it, expect, vi } from 'vitest';
import type { RunConfig } from '../../../src/core/agent/types.js';
import { makeRunConfig, makeStateMachineFake, makeStagnationFake } from '../../helpers/run-config.js';
import { runStepAgent } from '../../../src/core/agent/reason-runner.js';

// ONE leaf mock (round-8, candidate 2): no-op sleep keeps the retry loop
// fast. Everything else is real — runStepAgent takes its collaborators
// (agent, cfg, stagnation) as arguments, so the builder / git-guard /
// cognitive / model-info / checkpoint / locator / prompts / complete /
// compaction / defaults module mocks were testing nothing.

vi.mock('../../../src/core/failure/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/failure/index.js')>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});

// ---- helpers ----

function makeCfg(): RunConfig {
  return makeRunConfig({
    stateMachine: makeStateMachineFake({ extraParams: { maxFilesPerTask: 5 } }),
  });
}

function makeFailingAgent(boom: Error) {
  return {
    prompt: vi.fn().mockRejectedValue(boom),
    steer: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    abort: vi.fn(),
  };
}

// ---- tests ----

describe('runStepAgent', () => {
  describe('retry exhaustion', () => {
    it('rejects with the last captured error when all retries are exhausted', async () => {
      // The retry budget is a constant 3 inside runStepAgent (round-8, C1).
      const cfg = makeCfg();
      const stagnation = makeStagnationFake();
      const boom = new Error('LLM permanently unavailable');
      const fakeAgent = makeFailingAgent(boom);

      await expect(runStepAgent(fakeAgent as never, 'do something', cfg, stagnation as never)).rejects.toThrow(
        'LLM permanently unavailable',
      );
    });

    it('calls agent.prompt exactly maxRetries times before exhausting retries', async () => {
      const cfg = makeCfg();
      const stagnation = makeStagnationFake();
      const fakeAgent = makeFailingAgent(new Error('LLM permanently unavailable'));

      await runStepAgent(fakeAgent as never, 'do something', cfg, stagnation as never).catch(() => {});

      expect(fakeAgent.prompt).toHaveBeenCalledTimes(3);
    });
  });
});
