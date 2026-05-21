import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { astLocatorTool } from '../../tool/locator.js';
import { SafeModifier } from '../../tool/safety/index.js';
import { loadConfig } from '../../config/index.js';
import { LLMConnector } from '../../provider/llm.js';
import { StateMachineAgent } from '../session.js';
import { State } from '../types.js';
import type { StateResult } from '../types.js';
import type { ExecutionEvent, Mission } from './types.js';
import { buildModel, compressConversationHistory, runReasonStep, runStep } from './step-runner.js';
import type { EnvContext } from '../prompts/agent.js';

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
    modelName: string,
    provider: string,
    baseUrl: string,
    onEvent?: (event: ExecutionEvent) => void,
    initialMessages?: AgentMessage[],
  ): Promise<StateResult> {
    const mission: Mission = {
      id: `task-${Date.now()}`,
      description: input,
      state: 'running',
    };

    const stateMachine = new StateMachineAgent(modelName, [astLocatorTool]);
    const model = buildModel(modelName, provider, baseUrl);
    const agentConfig = loadConfig();

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
    };

    const cfg = {
      model,
      stateMachine,
      safetyConfig: agentConfig.safety ?? {},
      safeModifier: new SafeModifier(),
      env,
      temperature: LLMConnector.DEFAULT_TEMPERATURE,
      projectRoot: cwd,
      registerAgent: (a: Agent) => this._activeAgents.add(a),
      unregisterAgent: (a: Agent) => this._activeAgents.delete(a),
    };

    const conversationHistory = compressConversationHistory(initialMessages ?? [], {
      enableCompaction: true,
      compactionThreshold: 3000,
    });

    const { steps, needsClarify, questions } = await runReasonStep(mission, cfg, conversationHistory, onEvent);

    if (needsClarify) {
      onEvent?.({ type: 'clarification_needed', questions });
      return {
        state: State.DONE,
        success: true,
        output: 'Clarification needed',
        toolCalls: [],
        nextState: State.DONE,
        messages: [],
      };
    }

    const stepResults = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const handoff = await runStep(step, i, steps.length, mission, stepResults, cfg, onEvent);
      stepResults.push(handoff);
    }

    mission.state = 'completed';
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
