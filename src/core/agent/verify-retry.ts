import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { SafeModifier } from '../../tool/safety/index.js';
import { State } from '../types.js';
import type { StateResult, ExecutedStep, StepDirective } from '../types.js';
import type { ExecutionEvent, Mission, RunConfig } from './types.js';
import { runReasonStep, executeSteps } from './step-runner.js';
import type { ReasonStepOptions } from './step-runner.js';
import { flattenDirectives, planFingerprint } from './directives.js';
import { parseEditedFiles } from './step-context.js';
import { MemoryStore } from '../memory/index.js';

const MAX_VERIFY_RETRIES = 2;

/**
 * The VERIFY retry loop (Gap 38): execute the plan; on VERIFY failure
 * re-REASON with failure context, auto-rollback before a MODIFY-heavy retry,
 * and give up after MAX_VERIFY_RETRIES. Extracted from the ReactAgent facade
 * (third-pass review, candidate 10) — the test suite already mocked
 * step-runner at exactly this seam.
 */
export type VerifyLoopOutcome =
  | { kind: 'completed'; allStepResults: ExecutedStep[]; mission: Mission }
  | { kind: 'failed'; result: StateResult; mission: Mission };

export interface VerifyRetryOptions extends ReasonStepOptions {
  memoryStore?: MemoryStore | null;
}

async function rollbackEditedFiles(
  allStepResults: ExecutedStep[],
  safeModifier: SafeModifier,
  onEvent?: (e: ExecutionEvent) => void,
): Promise<void> {
  const editedFiles = allStepResults.filter((r) => r.state === State.MODIFY).flatMap((r) => parseEditedFiles(r.output));
  const uniqueEdited = [...new Set(editedFiles)];
  for (const filePath of uniqueEdited) {
    await safeModifier.restore(filePath);
  }
  if (uniqueEdited.length > 0) {
    onEvent?.({
      type: 'tool_execution_start',
      toolId: 'rollback',
      tool: 'rollback',
      args: { restored: uniqueEdited },
    });
  }
}

function buildVerifyFailureContext(
  allStepResults: ExecutedStep[],
  verifyResult: { passed: boolean; issues: string[]; summary: string },
  retryCount: number,
): string {
  const historyLines = allStepResults.map((r) => `- [${r.state}] ${r.focus}: ${r.output.slice(0, 300)}`).join('\n');

  return `[RETRY ${retryCount}/${MAX_VERIFY_RETRIES}]
Previous execution history:
${historyLines}

VERIFY FAILED:
Summary: ${verifyResult.summary}
Issues:
${verifyResult.issues.map((i) => `  - ${i}`).join('\n')}

Analyze what went wrong and plan a new approach. Consider:
- If the code change was wrong → use DIAGNOSE to find root cause, then MODIFY again
- If tests reveal a deeper bug → use DIAGNOSE first
- If the modification made things worse → start with ROLLBACK`;
}

/** One failure exit: failed StateResult + episode + failed mission (was ×4). */
function failRun(
  output: string,
  mission: Mission,
  allStepResults: ExecutedStep[],
  memoryStore: MemoryStore | null,
): VerifyLoopOutcome {
  const result: StateResult = {
    state: State.DONE,
    success: false,
    output,
    nextState: State.DONE,
    messages: [],
  };
  const failedMission = { ...mission, state: 'failed' as const };
  memoryStore?.writeEpisodeSync(failedMission, allStepResults, result);
  return { kind: 'failed', result, mission: failedMission };
}

export async function runWithVerifyRetry(
  initialSteps: StepDirective[],
  mission: Mission,
  conversationHistory: AgentMessage[],
  cfg: RunConfig,
  options: VerifyRetryOptions = {},
): Promise<VerifyLoopOutcome> {
  const { onEvent, memoryIndex, memorySearchTool, onNeedsClarify, memoryStore = null } = options;
  const allStepResults: ExecutedStep[] = [];
  let currentSteps = initialSteps;
  let prevStepsSignature = '';
  let verifySeen = false;
  let verifyFailed = false;
  let verifyRetryCount = 0;

  while (true) {
    const thisRoundResults = await executeSteps(currentSteps, mission, allStepResults, cfg, {
      onEvent,
      memoryIndex,
      memorySearchTool,
    });

    allStepResults.push(...thisRoundResults);

    const lastVerify = [...thisRoundResults].reverse().find((h) => h.state === State.VERIFY);

    if (lastVerify) {
      verifySeen = true;
      let verifyResult: { passed: boolean; issues: string[]; summary: string };
      try {
        verifyResult = JSON.parse(lastVerify.output) as typeof verifyResult;
      } catch {
        break;
      }
      if (verifyResult.passed === true) {
        break;
      }
      verifyFailed = true;
      verifyRetryCount++;

      if (verifyRetryCount > MAX_VERIFY_RETRIES) {
        return failRun(
          `Task failed after ${MAX_VERIFY_RETRIES} verification retries. Last error: ${verifyResult.summary}`,
          mission,
          allStepResults,
          memoryStore,
        );
      }

      const verifyFailureHistory: AgentMessage[] = [
        ...conversationHistory,
        {
          role: 'user' as const,
          content: buildVerifyFailureContext(allStepResults, verifyResult, verifyRetryCount),
          timestamp: Date.now(),
        },
      ];
      const { steps: verifyRetrySteps } = await runReasonStep(mission, cfg, verifyFailureHistory, {
        onEvent,
        onNeedsClarify,
        memoryIndex,
        memorySearchTool,
      });
      if (verifyRetrySteps.length === 0) {
        return failRun(
          `Task failed: verification failed and retry produced no steps. Last error: ${verifyResult.summary}`,
          mission,
          allStepResults,
          memoryStore,
        );
      }

      const verifySig = planFingerprint(verifyRetrySteps);
      if (verifySig === prevStepsSignature) {
        return failRun(
          `Task failed: retry plan identical to previous. Last error: ${verifyResult.summary}`,
          mission,
          allStepResults,
          memoryStore,
        );
      }
      prevStepsSignature = verifySig;

      const flatVerifyRetry = flattenDirectives(verifyRetrySteps);
      const verifyRetryHasModify = flatVerifyRetry.some((s) => s.state === State.MODIFY);
      const verifyRetryHasRollback = flatVerifyRetry.some((s) => s.state === State.ROLLBACK);
      if (verifyRetryHasModify && !verifyRetryHasRollback) {
        await rollbackEditedFiles(allStepResults, cfg.safeModifier, onEvent);
      }

      currentSteps = verifyRetrySteps;
    } else {
      if (verifySeen && verifyFailed) {
        return failRun(
          'Task failed: verification failed and retry plan did not include a VERIFY step.',
          mission,
          allStepResults,
          memoryStore,
        );
      }
      break;
    }
  }

  return { kind: 'completed', allStepResults, mission };
}
