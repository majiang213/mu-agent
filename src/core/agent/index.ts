import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { astLocatorTool } from '../../tool/locator.js';
import { SafeModifier } from '../../tool/safety/index.js';
import { webfetchTool } from '../../tool/webfetch.js';
import { websearchTool } from '../../tool/websearch.js';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { Config } from '../../config/types.js';
import { LLMConnector } from '../../provider/llm.js';
import { StateMachineAgent } from '../session.js';
import { State } from '../types.js';
import type { StateResult } from '../types.js';
import type { ExecutionEvent, Mission } from './types.js';
import { buildModel, compressConversationHistory, runReasonStep, runStep } from './step-runner.js';
export { compressConversationHistorySync } from './step-runner.js';
import type { EnvContext } from '../prompts/agent.js';
import { loadProjectContext } from '../project-context.js';
import { LspClient } from '../../tool/lsp.js';

export type { ExecutionEvent };

export class ReactAgent {
  private _pendingClarification: ((answer: string) => void) | null = null;
  private _activeAgents: Set<Agent> = new Set();

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

    const stateMachine = new StateMachineAgent(config.model.name, [
      astLocatorTool,
      webfetchTool as AgentTool<any, any>,
      websearchTool as AgentTool<any, any>,
    ]);
    const model = await buildModel(config.model.name, config.model.provider, config.model.baseUrl, config.model.apiKey);

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
      projectContext: loadProjectContext(cwd) ?? undefined,
    };

    const lspClient = new LspClient();
    await lspClient.init(cwd);

    const cfg = {
      model,
      stateMachine,
      safetyConfig: config.safety ?? {},
      safeModifier: new SafeModifier(),
      env,
      temperature: config.model.temperature ?? LLMConnector.DEFAULT_TEMPERATURE,
      projectRoot: cwd,
      registerAgent: (a: Agent) => this._activeAgents.add(a),
      unregisterAgent: (a: Agent) => this._activeAgents.delete(a),
      lspClient,
    };

    const conversationHistory = await compressConversationHistory(initialMessages ?? [], model);

    const { steps } = await runReasonStep(mission, cfg, conversationHistory, onEvent, async (questions) => {
      onEvent?.({ type: 'clarification_needed', questions });
      return new Promise<string>((resolve) => {
        this._pendingClarification = resolve;
      });
    });

    if (steps.length === 0) {
      mission.state = 'completed';
      lspClient.dispose();
      return { state: State.DONE, success: true, output: '', toolCalls: [], nextState: State.DONE, messages: [] };
    }

    const stepResults = [];
    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;
        const handoff = await runStep(step, i, steps.length, mission, stepResults, cfg, onEvent);
        stepResults.push(handoff);
      }
    } catch (err) {
      mission.state = 'failed';
      lspClient.dispose();
      throw err;
    }

    mission.state = 'completed';
    lspClient.dispose();
    return {
      state: State.DONE,
      success: true,
      output: stepResults[stepResults.length - 1]?.output ?? 'Task completed',
      toolCalls: [],
      nextState: State.DONE,
      messages: [],
    };
  }
}
