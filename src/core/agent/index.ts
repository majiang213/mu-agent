import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Config } from '../../config/types.js';
import { State } from '../types.js';
import type { StateResult, ExecutedStep } from '../types.js';
import type { ExecutionEvent, Mission } from './types.js';
import { runReasonStep, runStep } from './step-runner.js';
import { compressConversationHistoryWithLLM } from '../compaction/index.js';
import { buildRunSetup } from './setup.js';
import { isAbortError } from './abort.js';
import { runWithVerifyRetry } from './verify-retry.js';
import { MemoryStore } from '../memory/index.js';

export type { ExecutionEvent };

/**
 * ReactAgent — the facade. run() reads as a pipeline:
 * setup → reason → verify-retry loop → fixed ANSWER → episode.
 * The retry policy lives in verify-retry.ts, assembly in setup.ts.
 */
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
      const conversationHistory = await compressConversationHistoryWithLLM(
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
      const isAbort = isAbortError(err);
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
