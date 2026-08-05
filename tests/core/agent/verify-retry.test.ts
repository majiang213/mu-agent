import { describe, it, expect } from 'vitest';
import { State } from '../../../src/core/types.js';
import type { ExecutedStep, StepDirective } from '../../../src/core/types.js';
import type { RunConfig } from '../../../src/core/agent/types.js';
import { runWithVerifyRetry } from '../../../src/core/agent/verify-retry.js';
import { makeRunConfig, makeStateMachineFake } from '../../helpers/run-config.js';
import { makeScriptedDriver, type ScriptEntry } from '../../helpers/scripted-driver.js';

/**
 * The verify-retry loop tested through the StepAgentDriver seam (round-8,
 * candidate 2): a scripted driver plays the model (VERIFY outcomes, retry
 * REASON plans) through the real complete() tool, so executeSteps /
 * runReasonStep / the retry policy all run production code. Replaces the
 * step-runner.js / model-info.js / builder.js / checkpoint.js module mocks.
 */

function makeMission() {
  return { id: 'test-task', description: 'test task', state: 'running' as const };
}

function makeCfg(script: ScriptEntry[]): RunConfig {
  return makeRunConfig({
    stateMachine: makeStateMachineFake({ extraParams: { maxFilesPerTask: 5 } }),
    temperature: 0.7,
    stepDriver: makeScriptedDriver(script).driver,
  });
}

const noopClarify = async (_questions: string[]) => 'ok';

const VERIFY_PASS = { passed: true, issues: [], summary: 'all ok' };
const VERIFY_FAIL = { passed: false, issues: ['test failed'], summary: 'Tests failed' };
const MODIFY_OK = { edited: ['a.ts'], linesChanged: 1 };
const INITIAL = [{ state: State.VERIFY, focus: 'run tests' } as StepDirective];

describe('runWithVerifyRetry', () => {
  it('S1: VERIFY passes → kind:completed with allStepResults', async () => {
    const outcome = await runWithVerifyRetry(INITIAL, makeMission(), [], makeCfg([VERIFY_PASS]), {
      onNeedsClarify: noopClarify,
    });

    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      const verifyStep: ExecutedStep = {
        state: State.VERIFY,
        focus: 'run tests',
        output: JSON.stringify(VERIFY_PASS),
      };
      expect(outcome.allStepResults).toContainEqual(verifyStep);
      expect(outcome.mission.state).toBe('running');
    }
  });

  it('S2: VERIFY fails, retry returns empty steps → kind:failed', async () => {
    const outcome = await runWithVerifyRetry(
      INITIAL,
      makeMission(),
      [],
      makeCfg([VERIFY_FAIL, { steps: [], needsClarify: false }]),
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
    const outcome = await runWithVerifyRetry(
      INITIAL,
      makeMission(),
      [],
      makeCfg([
        // Round 1: VERIFY fails → retry plan [MODIFY, VERIFY].
        VERIFY_FAIL,
        {
          steps: [
            { state: 'MODIFY', focus: 'fix attempt 1' },
            { state: 'VERIFY', focus: 'run tests' },
          ],
          needsClarify: false,
        },
        MODIFY_OK,
        // Round 2: VERIFY fails again → retry plan [MODIFY, VERIFY] (new focus → new fingerprint).
        VERIFY_FAIL,
        {
          steps: [
            { state: 'MODIFY', focus: 'fix attempt 2' },
            { state: 'VERIFY', focus: 'run tests' },
          ],
          needsClarify: false,
        },
        MODIFY_OK,
        // Round 3: VERIFY fails a third time → retries exhausted.
        VERIFY_FAIL,
      ]),
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
