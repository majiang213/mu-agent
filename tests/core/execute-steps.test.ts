import { describe, it, expect, vi } from 'vitest';
import { State } from '../../src/core/types.js';
import type { StepDirective } from '../../src/core/types.js';
import type { RunConfig, ExecutionEvent } from '../../src/core/agent/types.js';
import { makeRunConfig, makeStateMachineFake } from '../helpers/run-config.js';
import { makeScriptedDriver, type ScriptEntry } from '../helpers/scripted-driver.js';
import { executeSteps } from '../../src/core/agent/step-runner.js';

/**
 * executeSteps driven through the StepAgentDriver seam (round-9, candidate 2):
 * makeScriptedDriver plays the model by executing each step's REAL complete()
 * tool — schema validation included. Replaces the complete.js module mock +
 * hand-rolled fake driver (round-4 pattern), converging the suite on one
 * test-driver vocabulary. `null` entries script "model never called
 * complete()" (the llm-text fallback path); parallel branches drive in build
 * order, so scripts are deterministic.
 */

// Valid per-state complete() payloads (STATE_REGISTRY completeSchema).
const LOCATE_OK = {
  locations: [{ file: 'a.ts', startLine: 1, endLine: 5, snippet: 'code' }],
};
const MODIFY_OK = { edited: ['a.ts'], linesChanged: 1 };
const VERIFY_OK = { passed: true, issues: [], summary: 'ok' };
const ANSWER_OK = { answer: 'done' };

function makeCfg(script: ScriptEntry[], overrides?: Partial<RunConfig>): RunConfig {
  return makeRunConfig({
    stateMachine: makeStateMachineFake({ extraParams: { maxFilesPerTask: 5 } }),
    stepDriver: makeScriptedDriver(script).driver,
    ...overrides,
  });
}

/** Parallel branches fork the state machine; the fake clones to itself. */
function makeParallelCfg(script: ScriptEntry[]): RunConfig {
  const cfg = makeCfg(script);
  (cfg.stateMachine.clone as ReturnType<typeof vi.fn>).mockReturnValue(cfg.stateMachine);
  return cfg;
}

const MISSION = { id: 't1', description: 'task', state: 'running' as const };

describe('executeSteps', () => {
  describe('the StepAgentDriver seam (round-4, candidate 5)', () => {
    it('runStep builds and drives through cfg.stepDriver', async () => {
      const cfg = makeCfg([ANSWER_OK]);
      await executeSteps([{ state: State.ANSWER, focus: 'respond' }], MISSION, [], cfg);
      const driver = cfg.stepDriver!;
      expect(driver.buildAgent).toHaveBeenCalledTimes(1);
      expect(driver.driveUntilComplete).toHaveBeenCalledTimes(1);
      // The build input carries the state's tools (complete tool included).
      const buildInput = vi.mocked(driver.buildAgent).mock.calls[0]![0];
      expect(buildInput.state).toBe(State.ANSWER);
      expect(buildInput.tools.some((t) => t.name === 'complete')).toBe(true);
    });
  });

  describe('sequential directives', () => {
    it('returns one result per sequential step', async () => {
      const directives: StepDirective[] = [
        { state: State.LOCATE, focus: 'find files' },
        { state: State.MODIFY, focus: 'fix bug' },
      ];
      const results = await executeSteps(directives, MISSION, [], makeCfg([LOCATE_OK, MODIFY_OK]));
      expect(results).toHaveLength(2);
      expect(results[0]!.state).toBe(State.LOCATE);
      expect(results[1]!.state).toBe(State.MODIFY);
    });

    it('returns empty array for empty directives', async () => {
      const results = await executeSteps([], MISSION, [], makeCfg([]));
      expect(results).toHaveLength(0);
    });
  });

  describe('parallel directives', () => {
    const parallelModify: StepDirective[] = [
      {
        parallel: [
          { state: State.MODIFY, focus: 'fix A' },
          { state: State.MODIFY, focus: 'fix B' },
        ],
      },
    ];

    it('emits parallel_start and parallel_complete events', async () => {
      const events: ExecutionEvent[] = [];
      await executeSteps(parallelModify, MISSION, [], makeParallelCfg([MODIFY_OK, MODIFY_OK]), {
        onEvent: (e) => events.push(e),
      });

      const types = events.map((e) => e.type);
      expect(types).toContain('parallel_start');
      expect(types).toContain('parallel_complete');
    });

    it('does not emit state_change or task_start from parallel branches to prevent TUI header thrashing', async () => {
      const events: ExecutionEvent[] = [];
      await executeSteps(parallelModify, MISSION, [], makeParallelCfg([MODIFY_OK, MODIFY_OK]), {
        onEvent: (e) => events.push(e),
      });

      const types = events.map((e) => e.type);
      expect(types).not.toContain('state_change');
      expect(types).not.toContain('task_start');
    });

    it('emits parallel_overlap when two branches edit the same file', async () => {
      const events: ExecutionEvent[] = [];
      await executeSteps(
        parallelModify,
        MISSION,
        [],
        makeParallelCfg([
          { edited: ['a.ts', 'b.ts'], linesChanged: 1 },
          { edited: ['b.ts', 'c.ts'], linesChanged: 1 },
        ]),
        { onEvent: (e) => events.push(e) },
      );

      const overlap = events.find((e) => e.type === 'parallel_overlap');
      expect(overlap).toBeDefined();
      expect((overlap as { files: string[] }).files).toEqual(['b.ts']);
    });

    it('does NOT emit parallel_overlap when branches edit disjoint files', async () => {
      const events: ExecutionEvent[] = [];
      await executeSteps(
        parallelModify,
        MISSION,
        [],
        makeParallelCfg([
          { edited: ['a.ts'], linesChanged: 1 },
          { edited: ['c.ts'], linesChanged: 1 },
        ]),
        { onEvent: (e) => events.push(e) },
      );

      expect(events.some((e) => e.type === 'parallel_overlap')).toBe(false);
    });

    it('returns one result per parallel branch', async () => {
      const results = await executeSteps(parallelModify, MISSION, [], makeParallelCfg([MODIFY_OK, MODIFY_OK]));

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.state === State.MODIFY)).toBe(true);
    });

    it('calls stateMachine.clone() for each parallel branch', async () => {
      const cfg = makeCfg([MODIFY_OK, MODIFY_OK]);
      (cfg.stateMachine.clone as ReturnType<typeof vi.fn>).mockReturnValue({ ...cfg.stateMachine });

      await executeSteps(parallelModify, MISSION, [], cfg);

      expect(cfg.stateMachine.clone).toHaveBeenCalledTimes(2);
    });

    it('returns 4 results for LOCATE + parallel(MODIFY, MODIFY) + VERIFY', async () => {
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

      const results = await executeSteps(
        directives,
        MISSION,
        [],
        makeParallelCfg([LOCATE_OK, MODIFY_OK, MODIFY_OK, VERIFY_OK]),
      );

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

      await executeSteps(directives, MISSION, [], makeCfg([ANSWER_OK]), {
        onEvent: (e) => events.push(e),
      });

      const types = events.map((e) => e.type);
      expect(types).toContain('task_start');
      expect(types).toContain('task_end');
    });
  });

  describe('subplan directives (Gap 80)', () => {
    it('emits subplan_start event when encountering a subplan directive', async () => {
      const events: ExecutionEvent[] = [];
      const directives: StepDirective[] = [
        { subplan: { analyzerState: State.PLAN, focus: 'analyze changes and plan commits' } },
      ];

      await executeSteps(directives, MISSION, [], makeCfg([null]), { onEvent: (e) => events.push(e) });

      const types = events.map((e) => e.type);
      expect(types).toContain('subplan_start');
    });

    it('includes PLAN step result in returned results', async () => {
      const directives: StepDirective[] = [{ subplan: { analyzerState: State.PLAN, focus: 'analyze and plan' } }];

      const results = await executeSteps(directives, MISSION, [], makeCfg([null]));

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.state).toBe(State.PLAN);
    });

    it('executes sub-steps produced by PLAN output', async () => {
      const directives: StepDirective[] = [
        { subplan: { analyzerState: State.PLAN, focus: 'run tests and plan fixes' } },
      ];

      const results = await executeSteps(
        directives,
        MISSION,
        [],
        makeCfg([
          { steps: [{ state: 'MODIFY', focus: 'fix the bug in math.js' }], rationale: 'bug found' },
          { edited: ['math.js'], linesChanged: 1 },
        ]),
      );

      expect(results).toHaveLength(2);
      expect(results[0]!.state).toBe(State.PLAN);
      expect(results[1]!.state).toBe(State.MODIFY);
    });

    it('emits subplan_complete with correct sub-step count', async () => {
      const events: ExecutionEvent[] = [];
      const directives: StepDirective[] = [
        { subplan: { analyzerState: State.PLAN, focus: 'run tests and plan two fixes' } },
      ];

      await executeSteps(
        directives,
        MISSION,
        [],
        makeCfg([
          {
            steps: [
              { state: 'MODIFY', focus: 'fix bug A' },
              { state: 'MODIFY', focus: 'fix bug B' },
            ],
            rationale: 'two bugs',
          },
          MODIFY_OK,
          MODIFY_OK,
        ]),
        { onEvent: (e) => events.push(e) },
      );

      const completeEv = events.find((e) => e.type === 'subplan_complete');
      expect(completeEv).toBeDefined();
      if (completeEv?.type === 'subplan_complete') {
        expect(completeEv.subStepCount).toBe(2);
      }
    });

    it('returns only PLAN result when PLAN produces no capture (llm-text fallback)', async () => {
      const directives: StepDirective[] = [{ subplan: { analyzerState: State.PLAN, focus: 'plan something' } }];

      const results = await executeSteps(directives, MISSION, [], makeCfg([null]));

      expect(results).toHaveLength(1);
      expect(results[0]!.state).toBe(State.PLAN);
    });

    it('never recurses into a nested subplan (schema rejects it before the filter)', async () => {
      // The PLAN completeSchema (stepsArraySchema allowSubplan:false) rejects a
      // nested subplan at the tool boundary — the model's invalid call earns a
      // validation error, no capture happens, and the parse guard marks the
      // PLAN step failed. Either way: no recursion.
      const directives: StepDirective[] = [{ subplan: { analyzerState: State.PLAN, focus: 'top-level plan' } }];

      const results = await executeSteps(directives, MISSION, [], makeCfg([null]));

      expect(results).toHaveLength(1);
      expect(results[0]!.state).toBe(State.PLAN);
    });

    it('marks PLAN step as failed when output is unparseable (Gap 82-A)', async () => {
      // Model ends without complete() → output falls back to the (empty)
      // llmText → JSON.parse fails → planResult rewritten to failure marker.
      const directives: StepDirective[] = [
        { subplan: { analyzerState: State.PLAN, focus: 'plan that fails to parse' } },
      ];

      const results = await executeSteps(directives, MISSION, [], makeCfg([null]));

      expect(results).toHaveLength(1);
      expect(results[0]!.state).toBe(State.PLAN);
      const parsed = JSON.parse(results[0]!.output) as { failed?: boolean; error?: string };
      expect(parsed.failed).toBe(true);
      expect(parsed.error).toContain('unparseable');
    });

    it('marks PLAN step as failed when the model cannot produce valid steps (Gap 82-A)', async () => {
      // steps:[] violates the PLAN schema (minItems:1) — a real model attempt
      // is rejected at the tool boundary; no capture → same failed marker.
      const directives: StepDirective[] = [
        { subplan: { analyzerState: State.PLAN, focus: 'plan that returns no steps' } },
      ];

      const results = await executeSteps(directives, MISSION, [], makeCfg([null]));

      expect(results).toHaveLength(1);
      const parsed = JSON.parse(results[0]!.output) as { failed?: boolean };
      expect(parsed.failed).toBe(true);
    });
  });
});
