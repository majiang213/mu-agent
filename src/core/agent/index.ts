import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { SafeModifier } from '../../tool/safety/index.js';
import type { Config } from '../../config/types.js';
import { State } from '../types.js';
import type { StateResult, ExecutedStep, StepDirective } from '../types.js';
import type { ExecutionEvent, Mission, RunConfig } from './types.js';
import { compressConversationHistory, runReasonStep, executeSteps, runStep } from './step-runner.js';
import type { ReasonStepOptions } from './step-runner.js';
import { buildRunSetup } from './setup.js';
import { flattenDirectives, planFingerprint } from './directives.js';
import { parseEditedFiles } from './step-context.js';
import { MemoryStore } from '../memory/index.js';

const MAX_VERIFY_RETRIES = 2;

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

function stepsSignature(directives: StepDirective[]): string {
  return planFingerprint(directives);
}

function _buildVerifyFailureContext(
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

export type VerifyLoopOutcome =
  | { kind: 'completed'; allStepResults: ExecutedStep[]; mission: Mission }
  | { kind: 'failed'; result: StateResult; mission: Mission };

export interface VerifyRetryOptions extends ReasonStepOptions {
  memoryStore?: MemoryStore | null;
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
        const result: StateResult = {
          state: State.DONE,
          success: false,
          output: `Task failed after ${MAX_VERIFY_RETRIES} verification retries. Last error: ${verifyResult.summary}`,
          nextState: State.DONE,
          messages: [],
        };
        const failedMission = { ...mission, state: 'failed' as const };
        memoryStore?.writeEpisodeSync(failedMission, allStepResults, result);
        return { kind: 'failed', result, mission: failedMission };
      }

      const verifyFailureHistory: AgentMessage[] = [
        ...conversationHistory,
        {
          role: 'user' as const,
          content: _buildVerifyFailureContext(allStepResults, verifyResult, verifyRetryCount),
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
        const result: StateResult = {
          state: State.DONE,
          success: false,
          output: `Task failed: verification failed and retry produced no steps. Last error: ${verifyResult.summary}`,
          nextState: State.DONE,
          messages: [],
        };
        const failedMission = { ...mission, state: 'failed' as const };
        memoryStore?.writeEpisodeSync(failedMission, allStepResults, result);
        return { kind: 'failed', result, mission: failedMission };
      }

      const verifySig = stepsSignature(verifyRetrySteps);
      if (verifySig === prevStepsSignature) {
        const result: StateResult = {
          state: State.DONE,
          success: false,
          output: `Task failed: retry plan identical to previous. Last error: ${verifyResult.summary}`,
          nextState: State.DONE,
          messages: [],
        };
        const failedMission = { ...mission, state: 'failed' as const };
        memoryStore?.writeEpisodeSync(failedMission, allStepResults, result);
        return { kind: 'failed', result, mission: failedMission };
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
        const result: StateResult = {
          state: State.DONE,
          success: false,
          output: `Task failed: verification failed and retry plan did not include a VERIFY step.`,
          nextState: State.DONE,
          messages: [],
        };
        const failedMission = { ...mission, state: 'failed' as const };
        memoryStore?.writeEpisodeSync(failedMission, allStepResults, result);
        return { kind: 'failed', result, mission: failedMission };
      }
      break;
    }
  }

  return { kind: 'completed', allStepResults, mission };
}

export type { ExecutionEvent };

export class ReactAgent {
  private _pendingClarification: ((answer: string) => void) | null = null;
  private _activeAgents: Set<Agent> = new Set();
  private _memoryStore: MemoryStore | null = null;
  private _isRunning = false;
  private _aborted = false;

  abort(): void {
    this._aborted = true;
    for (const agent of [...this._activeAgents]) {
      agent.abort();
    }
    this._activeAgents.clear();
  }

  registerAgent(a: Agent): void {
    this._activeAgents.add(a);
    if (this._aborted) {
      a.abort();
    }
  }

  provideClarification(answer: string): void {
    if (this._pendingClarification) {
      this._pendingClarification(answer);
      this._pendingClarification = null;
    }
  }

  async run(
    input: string,
    config: Config,
    onEvent?: (event: ExecutionEvent) => void,
    initialMessages?: AgentMessage[],
    options?: { cwd?: string },
  ): Promise<StateResult> {
    const baseMission: Mission = {
      id: `task-${Date.now()}`,
      description: input,
      state: 'running',
    };
    let mission = { ...baseMission };

    if (this._isRunning) throw new Error('ReactAgent.run() already running');
    this._isRunning = true;

    const cwd = options?.cwd ?? process.cwd();
    const setup = await buildRunSetup(config, cwd, {
      registerAgent: (a: Agent) => this.registerAgent(a),
      unregisterAgent: (a) => this._activeAgents.delete(a),
    });
    this._memoryStore = setup.memoryStore;
    const { cfg, memoryIndex, memorySearchTool } = setup;

    onEvent?.({
      type: 'session_info',
      provider: config.model.provider,
      tier: cfg.stateMachine.getModelParams().tier,
      contextWindow: cfg.model.contextWindow,
    });

    const clarifyCallback = async (questions: string[]): Promise<string> => {
      onEvent?.({ type: 'clarification_needed', questions });
      return new Promise<string>((resolve) => {
        this._pendingClarification = resolve;
      });
    };

    const allStepResults: ExecutedStep[] = [];

    try {
      const conversationHistory = await compressConversationHistory(
        initialMessages ?? [],
        cfg.model,
        cfg.contextRatio,
        cfg.apiKey,
      );

      const { steps } = await runReasonStep(mission, cfg, conversationHistory, {
        onEvent,
        onNeedsClarify: clarifyCallback,
        memoryIndex,
        memorySearchTool,
      });

      const outcome = await runWithVerifyRetry(steps, mission, conversationHistory, cfg, {
        onEvent,
        memoryIndex,
        memorySearchTool,
        onNeedsClarify: clarifyCallback,
        memoryStore: this._memoryStore,
      });

      if (outcome.kind === 'failed') {
        mission = outcome.mission;
        return outcome.result;
      }

      mission = outcome.mission;
      allStepResults.push(...outcome.allStepResults);

      // Fixed ANSWER step — always runs after all planned steps, independent of REASON's plan (Gap 51).
      // ANSWER synthesizes all step results for the user. It has only the complete() tool,
      // so there is no "print text" escape hatch — the model must call complete(answer="...").
      // Skip if REASON already planned an ANSWER step (e.g. chitchat) to avoid double-summary.
      const lastExecuted = allStepResults[allStepResults.length - 1];
      if (lastExecuted?.state !== State.ANSWER) {
        const answerFocus =
          allStepResults.length === 0
            ? 'Answer the user directly based on the task description.'
            : 'Summarize all previous steps and present the result to the user.';
        let answerStep: ExecutedStep;
        try {
          answerStep = await runStep(
            { state: State.ANSWER, focus: answerFocus },
            allStepResults.length,
            allStepResults.length + 1,
            mission,
            allStepResults,
            cfg,
            { onEvent, memoryIndex, memorySearchTool },
          );
        } catch {
          // ANSWER is best-effort — degrade gracefully to last step output
          answerStep = {
            state: State.ANSWER,
            focus: answerFocus,
            output: lastExecuted?.output ?? JSON.stringify({ answer: '[Unable to generate response]' }),
          };
        }
        allStepResults.push(answerStep);
      }

      const finalResult: StateResult = {
        state: State.DONE,
        success: true,
        output: allStepResults[allStepResults.length - 1]?.output ?? 'Task completed',
        nextState: State.DONE,
        messages: [],
      };
      this._memoryStore?.writeEpisodeSync(mission, allStepResults, finalResult);
      mission = { ...mission, state: 'completed' as const };
      return finalResult;
    } catch (err) {
      const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'));
      if (!isAbort) {
        const errResult: StateResult = {
          state: State.DONE,
          success: false,
          output: err instanceof Error ? err.message : String(err),
          nextState: State.DONE,
          messages: [],
        };
        this._memoryStore?.writeEpisodeSync(mission, allStepResults, errResult);
      }
      throw err;
    } finally {
      setup.close();
      await setup.pendingSummaries;
      this._isRunning = false;
    }
  }
}
