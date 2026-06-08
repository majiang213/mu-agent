import { describe, it, expect, vi, beforeEach } from 'vitest';
import { State } from '../../src/core/types.js';
import type { StepDirective, ExecutedStep } from '../../src/core/types.js';
import type { RunConfig, ExecutionEvent } from '../../src/core/agent/types.js';

vi.mock('../../src/core/agent/builder.js', () => ({
  buildStepAgent: vi.fn(() => ({
    prompt: vi.fn(async () => {}),
    steer: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  })),
  subscribeStepEvents: vi.fn(),
}));

vi.mock('../../src/core/cognitive/index.js', () => ({
  StagnationDetector: vi.fn(function () {
    return {
      recordToolCall: vi.fn(),
      recordError: vi.fn(),
      check: vi.fn(() => ({ detected: false })),
      reset: vi.fn(),
    };
  }),
}));

vi.mock('../../src/core/graph/locator.js', () => ({
  CodeGraphLocator: vi.fn(function () {
    return {
      locate: vi.fn(() => ({ tree: '', suggestedFiles: [], snippets: {} })),
      updateFiles: vi.fn(),
    };
  }),
}));

vi.mock('../../src/core/failure/handler.js', () => ({
  FailureHandler: vi.fn(function () {
    return {
      createContext: vi.fn(() => ({})),
      handleFailure: vi.fn(async () => ({ action: 'abort' })),
    };
  }),
}));

vi.mock('../../src/core/prompts/index.js', () => ({
  buildSystemPrompt: vi.fn(() => 'system'),
  buildUserPrompt: vi.fn(() => 'user'),
}));

vi.mock('../../src/core/states.js', () => ({
  advanceState: vi.fn((_s: unknown, traj: State[]) => traj[traj.length - 1] ?? State.DONE),
}));

vi.mock('../../src/tool/complete.js', () => ({
  buildCompleteTool: vi.fn((state: State, onComplete: (args: Record<string, unknown>) => void) => ({
    name: 'complete',
    label: 'Complete',
    description: '',
    parameters: {},
    execute: async (_id: unknown, args: Record<string, unknown>) => {
      onComplete(args);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  })),
}));

const { buildStepAgent, subscribeStepEvents } = await import('../../src/core/agent/builder.js');

function captureComplete(onComplete: (args: Record<string, unknown>) => void, state: State): void {
  const schemas: Record<string, Record<string, unknown>> = {
    LOCATE: { locations: [] },
    MODIFY: { edited: [], linesChanged: 0 },
    VERIFY: { passed: true, issues: [], summary: 'ok' },
    ANSWER: { answer: 'done' },
  };
  const result = schemas[state] ?? { result: 'ok' };
  onComplete(result);
}

const { buildCompleteTool } = await import('../../src/tool/complete.js');
vi.mocked(buildCompleteTool).mockImplementation((state, onComplete) => ({
  name: 'complete',
  label: 'Complete',
  description: '',
  parameters: {} as never,
  execute: async () => {
    captureComplete(onComplete, state);
    return { content: [{ type: 'text' as const, text: 'ok' }], details: undefined };
  },
}));

vi.mocked(buildStepAgent).mockImplementation((_sysprompt, _msgs, _cfg, _onEvent, tools) => {
  const agent = {
    prompt: vi.fn(async () => {
      const completeTool = tools?.find((t) => t.name === 'complete');
      if (completeTool) {
        await completeTool.execute('id', {}, {} as never);
      }
    }),
    steer: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    abort: vi.fn(),
  };
  return agent as never;
});

vi.mocked(subscribeStepEvents).mockImplementation(() => {});

import { executeSteps } from '../../src/core/agent/step-runner.js';

function makeCfg(overrides?: Partial<RunConfig>): RunConfig {
  const stateMachine = {
    clone: vi.fn(),
    resetForNextTask: vi.fn(),
    getAllowedTools: vi.fn(() => []),
    getModelParams: vi.fn(() => ({
      tier: 'LARGE' as const,
      maxRetries: 1,
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
    ...overrides,
  };
}

describe('executeSteps', () => {
  describe('sequential directives', () => {
    it('returns one result per sequential step', async () => {
      const directives: StepDirective[] = [
        { state: State.LOCATE, focus: 'find files' },
        { state: State.MODIFY, focus: 'fix bug' },
      ];
      const results = await executeSteps(
        directives,
        { id: 't1', description: 'task', state: 'running' },
        [],
        makeCfg(),
      );
      expect(results).toHaveLength(2);
      expect(results[0]!.state).toBe(State.LOCATE);
      expect(results[1]!.state).toBe(State.MODIFY);
    });

    it('returns empty array for empty directives', async () => {
      const results = await executeSteps([], { id: 't1', description: 'task', state: 'running' }, [], makeCfg());
      expect(results).toHaveLength(0);
    });
  });

  describe('parallel directives', () => {
    it('emits parallel_start and parallel_complete events', async () => {
      const cfg = makeCfg();
      (cfg.stateMachine.clone as ReturnType<typeof vi.fn>).mockReturnValue(cfg.stateMachine);

      const events: ExecutionEvent[] = [];
      const directives: StepDirective[] = [
        {
          parallel: [
            { state: State.MODIFY, focus: 'fix A' },
            { state: State.MODIFY, focus: 'fix B' },
          ],
        },
      ];

      await executeSteps(directives, { id: 't1', description: 'task', state: 'running' }, [], cfg, (e) =>
        events.push(e),
      );

      const types = events.map((e) => e.type);
      expect(types).toContain('parallel_start');
      expect(types).toContain('parallel_complete');
    });

    it('does not emit state_change or task_start from parallel branches to prevent TUI header thrashing', async () => {
      const cfg = makeCfg();
      (cfg.stateMachine.clone as ReturnType<typeof vi.fn>).mockReturnValue(cfg.stateMachine);

      const events: ExecutionEvent[] = [];
      const directives: StepDirective[] = [
        {
          parallel: [
            { state: State.MODIFY, focus: 'fix A' },
            { state: State.MODIFY, focus: 'fix B' },
          ],
        },
      ];

      await executeSteps(directives, { id: 't1', description: 'task', state: 'running' }, [], cfg, (e) =>
        events.push(e),
      );

      const types = events.map((e) => e.type);
      expect(types).not.toContain('state_change');
      expect(types).not.toContain('task_start');
    });

    it('returns one result per parallel branch', async () => {
      const cfg = makeCfg();
      (cfg.stateMachine.clone as ReturnType<typeof vi.fn>).mockReturnValue(cfg.stateMachine);

      const directives: StepDirective[] = [
        {
          parallel: [
            { state: State.MODIFY, focus: 'fix A' },
            { state: State.MODIFY, focus: 'fix B' },
          ],
        },
      ];

      const results = await executeSteps(directives, { id: 't1', description: 'task', state: 'running' }, [], cfg);

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.state === State.MODIFY)).toBe(true);
    });

    it('calls stateMachine.clone() for each parallel branch', async () => {
      const cfg = makeCfg();
      (cfg.stateMachine.clone as ReturnType<typeof vi.fn>).mockReturnValue({ ...cfg.stateMachine });

      const directives: StepDirective[] = [
        {
          parallel: [
            { state: State.MODIFY, focus: 'fix A' },
            { state: State.MODIFY, focus: 'fix B' },
          ],
        },
      ];

      await executeSteps(directives, { id: 't1', description: 'task', state: 'running' }, [], cfg);

      expect(cfg.stateMachine.clone).toHaveBeenCalledTimes(2);
    });

    it('returns 4 results for LOCATE + parallel(MODIFY, MODIFY) + VERIFY', async () => {
      const cfg = makeCfg();
      (cfg.stateMachine.clone as ReturnType<typeof vi.fn>).mockReturnValue(cfg.stateMachine);

      const directives: StepDirective[] = [
        { state: State.LOCATE, focus: 'find files' },
        {
          parallel: [
            { state: State.MODIFY, focus: 'fix A' },
            { state: State.MODIFY, focus: 'fix B' },
          ],
        },
        { state: State.VERIFY, focus: 'run tests' },
      ];

      const results = await executeSteps(directives, { id: 't1', description: 'task', state: 'running' }, [], cfg);

      expect(results).toHaveLength(4);
      expect(results[0]!.state).toBe(State.LOCATE);
      expect(results[3]!.state).toBe(State.VERIFY);
      const middleStates = [results[1]!.state, results[2]!.state];
      expect(middleStates.every((s) => s === State.MODIFY)).toBe(true);
    });
  });

  describe('event emission for single sequential step', () => {
    it('emits task_start and task_end for a sequential step', async () => {
      const events: ExecutionEvent[] = [];
      const directives: StepDirective[] = [{ state: State.ANSWER, focus: 'respond' }];

      await executeSteps(directives, { id: 't1', description: 'task', state: 'running' }, [], makeCfg(), (e) =>
        events.push(e),
      );

      const types = events.map((e) => e.type);
      expect(types).toContain('task_start');
      expect(types).toContain('task_end');
    });
  });
});
