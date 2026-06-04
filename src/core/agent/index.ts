import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentMessage, AgentTool } from '@mariozechner/pi-agent-core';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { astLocatorTool } from '../../tool/locator.js';
import { SafeModifier } from '../../tool/safety/index.js';
import { webfetchTool } from '../../tool/webfetch.js';
import { websearchTool } from '../../tool/websearch.js';
import type { Config } from '../../config/types.js';
import { DEFAULT_TEMPERATURE, DEFAULT_CONTEXT_RATIO } from '../../config/defaults.js';
import { StateMachineAgent } from '../session/index.js';
import { State } from '../types.js';
import type { StateResult, Step, ExecutedStep, StepDirective } from '../types.js';
import type { ExecutionEvent, Mission } from './types.js';
import { buildModel, compressConversationHistory, runReasonStep, executeSteps, runStep } from './step-runner.js';
import { fetchOllamaParamCount } from '../../provider/model-info.js';
export { compressConversationHistorySync } from './step-runner.js';
import type { EnvContext } from '../prompts/agent.js';
import { loadContext } from './context.js';
import { LspClient } from '../../tool/lsp.js';
import { MemoryStore, findGitRoot, initMemoryDb, formatMemoryIndex } from '../memory/index.js';
import { createMemorySearchTool } from '../../tool/memory-search.js';

const MAX_VERIFY_RETRIES = 2;

function stepsSignature(directives: StepDirective[]): string {
  return directives
    .flatMap((d) => ('parallel' in d ? d.parallel : [d]))
    .map((s) => `${s.state}:${s.focus}`)
    .join('|');
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
  ): Promise<StateResult> {
    const mission: Mission = {
      id: `task-${Date.now()}`,
      description: input,
      state: 'running',
    };

    const contextRatio = config.model.contextRatio ?? DEFAULT_CONTEXT_RATIO;
    const [paramCount, model] = await Promise.all([
      config.model.provider === 'ollama'
        ? fetchOllamaParamCount(config.model.baseUrl, config.model.name)
        : Promise.resolve(config.model.modelSize != null ? config.model.modelSize * 1e9 : null),
      buildModel(config.model.name, config.model.provider, config.model.baseUrl, contextRatio, config.model.apiKey),
    ]);

    const stateMachine = new StateMachineAgent(
      config.model.name,
      // Cast needed: pi-agent-core's AgentTool<TParameters> requires TSchema [Kind] symbol
      // which @sinclair/typebox TObject lacks — pre-existing upstream type gap
      [astLocatorTool, webfetchTool as AgentTool<any, any>, websearchTool as AgentTool<any, any>],
      paramCount,
    );

    const cwd = process.cwd();
    const home = homedir();
    const cwdDisplay = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
    let isGitRepo: boolean;
    try {
      execSync('git rev-parse --git-dir', { stdio: 'ignore' });
      isGitRepo = true;
    } catch {
      isGitRepo = false;
    }

    const env: EnvContext = {
      cwd: cwdDisplay,
      platform: process.platform,
      isGitRepo,
      date: new Date().toDateString(),
      projectContext: loadContext(cwd) ?? undefined,
    };

    if (this._isRunning) throw new Error('ReactAgent.run() already running');
    this._isRunning = true;

    const lspClient = new LspClient();
    await lspClient.init(cwd);

    const gitRoot = findGitRoot(cwd);
    const memDb = initMemoryDb(gitRoot);
    this._memoryStore = new MemoryStore(memDb, cwd, model);
    const pendingSummariesPromise = this._memoryStore.processPendingSummaries().catch(() => {});
    const memoryIndex = formatMemoryIndex(memDb, cwd);
    const memorySearchTool = createMemorySearchTool(memDb, cwd) as unknown as AgentTool<any, any>;
    const closeMemDb = () => {
      try {
        memDb.close();
      } catch {
        /* db already closed */
      }
    };

    const cfg = {
      model,
      stateMachine,
      safetyConfig: config.safety ?? {},
      safeModifier: new SafeModifier(),
      env,
      temperature: config.model.temperature ?? DEFAULT_TEMPERATURE,
      contextRatio,
      apiKey: config.model.apiKey ?? 'ollama',
      projectRoot: cwd,
      registerAgent: (a: Agent) => this.registerAgent(a),
      unregisterAgent: (a: Agent) => this._activeAgents.delete(a),
      lspClient,
      heavyThinking: config.heavyThinking,
    };

    onEvent?.({
      type: 'session_info',
      provider: config.model.provider,
      tier: stateMachine.getModelParams().tier,
      contextWindow: model.contextWindow,
    });

    const clarifyCallback = async (questions: string[]): Promise<string> => {
      onEvent?.({ type: 'clarification_needed', questions });
      return new Promise<string>((resolve) => {
        this._pendingClarification = resolve;
      });
    };

    const allStepResults: ExecutedStep[] = [];
    let currentSteps: StepDirective[];
    let prevStepsSignature = '';
    let verifySeen = false;
    let verifyFailed = false;
    let noVerifyRetried = false;

    try {
      const conversationHistory = await compressConversationHistory(
        initialMessages ?? [],
        model,
        contextRatio,
        cfg.apiKey,
      );

      const { steps } = await runReasonStep(
        mission,
        cfg,
        conversationHistory,
        onEvent,
        clarifyCallback,
        memoryIndex,
        memorySearchTool,
      );

      currentSteps = steps;

      while (true) {
        const thisRoundResults = await executeSteps(
          currentSteps,
          mission,
          allStepResults,
          cfg,
          onEvent,
          memoryIndex,
          memorySearchTool,
        );

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
            verifyFailed = false;
            break;
          }
          verifyFailed = true;

          if (verifySeen && noVerifyRetried) {
            // We already retried once without VERIFY, and VERIFY still fails — report failure
            const failedResult: StateResult = {
              state: State.DONE,
              success: false,
              output: `Task failed after verification failure. Last error: ${verifyResult.summary}`,
              toolCalls: [],
              nextState: State.DONE,
              messages: [],
            };
            this._memoryStore?.writeEpisodeSync(mission, allStepResults, failedResult);
            mission.state = 'failed';
            return failedResult;
          }

          // Let the loop continue — the else branch will handle retry
        } else {
          // No VERIFY in this round
          if (verifySeen && verifyFailed) {
            // Previous VERIFY failed and this round has no VERIFY — report failure
            const failedResult: StateResult = {
              state: State.DONE,
              success: false,
              output: `Task failed: verification failed and retry plan did not include a VERIFY step.`,
              toolCalls: [],
              nextState: State.DONE,
              messages: [],
            };
            this._memoryStore?.writeEpisodeSync(mission, allStepResults, failedResult);
            mission.state = 'failed';
            return failedResult;
          }
          if (verifySeen && !verifyFailed) break;
          // No VERIFY seen yet — try a retry
          if (noVerifyRetried) {
            // Already retried once without VERIFY — break with success
            break;
          }
          noVerifyRetried = true;
          const { steps: retrySteps } = await runReasonStep(
            mission,
            cfg,
            conversationHistory,
            onEvent,
            clarifyCallback,
            memoryIndex,
            memorySearchTool,
          );
          if (retrySteps.length === 0) {
            if (verifyFailed) {
              const failedResult: StateResult = {
                state: State.DONE,
                success: false,
                output: `Task failed: verification failed and retry produced no steps.`,
                toolCalls: [],
                nextState: State.DONE,
                messages: [],
              };
              this._memoryStore?.writeEpisodeSync(mission, allStepResults, failedResult);
              mission.state = 'failed';
              return failedResult;
            }
            // Don't break yet — the current round's steps may contain VERIFY
            // that hasn't been processed. Continue the loop.
            if (verifySeen) break;
            // verifySeen is false, retrySteps is empty — the current plan
            // will be re-executed, which will find VERIFY and set verifyFailed.
            // Use the original steps to give the loop another iteration.
            continue;
          }
          const thisSig = stepsSignature(retrySteps);
          if (thisSig === prevStepsSignature) break;
          prevStepsSignature = thisSig;

          const flatRetry = retrySteps.flatMap((d) => ('parallel' in d ? d.parallel : [d]));
          const hasModify = flatRetry.some((s: Step) => s.state === State.MODIFY);
          const hasRollback = flatRetry.some((s: Step) => s.state === State.ROLLBACK);
          if (hasModify && !hasRollback) {
            const editedFiles = allStepResults
              .filter((r) => r.state === State.MODIFY)
              .flatMap((r) => {
                try {
                  const parsed = JSON.parse(r.output) as { edited?: unknown };
                  return Array.isArray(parsed.edited)
                    ? parsed.edited.filter((f): f is string => typeof f === 'string')
                    : [];
                } catch {
                  return [];
                }
              });
            const uniqueEdited = [...new Set(editedFiles)];
            for (const filePath of uniqueEdited) {
              await cfg.safeModifier.restore(filePath);
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

          currentSteps = retrySteps;
        }
      }

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
            onEvent,
            memoryIndex,
            memorySearchTool,
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
        toolCalls: [],
        nextState: State.DONE,
        messages: [],
      };
      this._memoryStore?.writeEpisodeSync(mission, allStepResults, finalResult);
      mission.state = 'completed';
      return finalResult;
    } catch (err) {
      const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'));
      if (!isAbort) {
        const errResult: StateResult = {
          state: State.DONE,
          success: false,
          output: err instanceof Error ? err.message : String(err),
          toolCalls: [],
          nextState: State.DONE,
          messages: [],
        };
        this._memoryStore?.writeEpisodeSync(mission, allStepResults, errResult);
      }
      mission.state = 'failed';
      throw err;
    } finally {
      lspClient.dispose();
      await pendingSummariesPromise;
      closeMemDb();
      this._isRunning = false;
    }
  }
}
