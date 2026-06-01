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
import { buildModel, compressConversationHistory, runReasonStep, executeSteps } from './step-runner.js';
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

export type { ExecutionEvent };

export class ReactAgent {
  private _pendingClarification: ((answer: string) => void) | null = null;
  private _activeAgents: Set<Agent> = new Set();
  private _memoryStore: MemoryStore | null = null;

  abort(): void {
    for (const agent of this._activeAgents) {
      agent.abort();
    }
    this._activeAgents.clear();
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

    const paramCount =
      config.model.provider === 'ollama'
        ? await fetchOllamaParamCount(config.model.baseUrl, config.model.name)
        : config.model.modelSize != null
          ? config.model.modelSize * 1e9
          : null;

    const stateMachine = new StateMachineAgent(
      config.model.name,
      // Cast needed: pi-agent-core's AgentTool<TParameters> requires TSchema [Kind] symbol
      // which @sinclair/typebox TObject lacks — pre-existing upstream type gap
      [astLocatorTool, webfetchTool as AgentTool<any, any>, websearchTool as AgentTool<any, any>],
      paramCount,
    );
    const contextRatio = config.model.contextRatio ?? DEFAULT_CONTEXT_RATIO;
    const model = await buildModel(
      config.model.name,
      config.model.provider,
      config.model.baseUrl,
      contextRatio,
      config.model.apiKey,
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
      registerAgent: (a: Agent) => this._activeAgents.add(a),
      unregisterAgent: (a: Agent) => this._activeAgents.delete(a),
      lspClient,
      heavyThinking: config.heavyThinking,
    };

    const conversationHistory = await compressConversationHistory(
      initialMessages ?? [],
      model,
      contextRatio,
      cfg.apiKey,
    );

    const clarifyCallback = async (questions: string[]): Promise<string> => {
      onEvent?.({ type: 'clarification_needed', questions });
      return new Promise<string>((resolve) => {
        this._pendingClarification = resolve;
      });
    };

    const { steps } = await runReasonStep(
      mission,
      cfg,
      conversationHistory,
      onEvent,
      clarifyCallback,
      memoryIndex,
      memorySearchTool,
    );

    if (steps.length === 0) {
      mission.state = 'completed';
      lspClient.dispose();
      await pendingSummariesPromise;
      closeMemDb();
      return { state: State.DONE, success: true, output: '', toolCalls: [], nextState: State.DONE, messages: [] };
    }

    const allStepResults: ExecutedStep[] = [];
    let currentSteps: StepDirective[] = steps;
    let verifyRetries = 0;
    let prevStepsSignature = '';

    try {
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

        if (!lastVerify) break;

        let verifyResult: { passed: boolean; issues: string[]; summary: string };
        try {
          verifyResult = JSON.parse(lastVerify.output) as typeof verifyResult;
        } catch {
          break;
        }
        if (verifyResult.passed === true) break;

        if (verifyRetries >= MAX_VERIFY_RETRIES) {
          const failedResult: StateResult = {
            state: State.DONE,
            success: false,
            output: `Task failed after ${MAX_VERIFY_RETRIES + 1} attempts. Last error: ${verifyResult.summary}`,
            toolCalls: [],
            nextState: State.DONE,
            messages: [],
          };
          this._memoryStore?.writeEpisodeSync(mission, allStepResults, failedResult);
          mission.state = 'failed';
          lspClient.dispose();
          await pendingSummariesPromise;
          closeMemDb();
          return failedResult;
        }

        verifyRetries++;

        const failureSummaryMsg: AgentMessage = {
          role: 'user',
          content: buildVerifyFailureContext(allStepResults, verifyResult, verifyRetries),
          timestamp: Date.now(),
        };
        const retryHistory = [...conversationHistory, failureSummaryMsg];

        const { steps: retrySteps } = await runReasonStep(
          mission,
          cfg,
          retryHistory,
          onEvent,
          clarifyCallback,
          memoryIndex,
          memorySearchTool,
        );

        if (retrySteps.length === 0) break;

        const thisSig = stepsSignature(retrySteps);
        if (thisSig === prevStepsSignature) break;
        prevStepsSignature = thisSig;

        const flatRetry = retrySteps.flatMap((d) => ('parallel' in d ? d.parallel : [d]));
        const hasModify = flatRetry.some((s: Step) => s.state === State.MODIFY);
        const hasRollback = flatRetry.some((s: Step) => s.state === State.ROLLBACK);
        if (hasModify && !hasRollback) {
          retrySteps.unshift({ state: State.ROLLBACK, focus: 'Restore all modified files to checkpoint before retry' });
        }

        currentSteps = retrySteps;
      }
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
      lspClient.dispose();
      await pendingSummariesPromise;
      closeMemDb();
      throw err;
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
    lspClient.dispose();
    await pendingSummariesPromise;
    closeMemDb();
    return finalResult;
  }
}
