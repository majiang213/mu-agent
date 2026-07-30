import { createCodingTools, createGrepTool, createLsTool, createFindTool } from '@earendil-works/pi-coding-agent';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { State, type ModelParams, type StateConfig } from '../types.js';
import { detectModelParams, getBaseStateConfigs, getNextState } from '../states.js';

interface StateMachineConfig {
  modelParams: ModelParams;
  states: Record<State, StateConfig>;
}

export class StateMachineAgent {
  private config: StateMachineConfig;
  private currentState: State;
  private allTools: AgentTool[];
  private fileCount: number;
  private readonly modelName: string;
  private readonly extraTools: AgentTool[];
  private readonly paramCount: number | null;
  private readonly projectRoot: string;

  constructor(
    modelName: string,
    extraTools: AgentTool<any, any>[] = [],
    paramCount: number | null = null,
    projectRoot: string = process.cwd(),
  ) {
    this.modelName = modelName;
    this.extraTools = extraTools;
    this.paramCount = paramCount;
    this.projectRoot = projectRoot;
    const modelParams = detectModelParams(paramCount);
    const states = getBaseStateConfigs();

    this.config = {
      modelParams,
      states,
    };

    this.currentState = State.REASON;
    this.fileCount = 0;
    this.allTools = [
      ...createCodingTools(projectRoot),
      createGrepTool(projectRoot) as AgentTool<any, any>,
      createLsTool(projectRoot) as AgentTool<any, any>,
      createFindTool(projectRoot) as AgentTool<any, any>,
      ...extraTools,
    ];
  }

  clone(): StateMachineAgent {
    const cloned = new StateMachineAgent(this.modelName, [...this.extraTools], this.paramCount, this.projectRoot);
    cloned.fileCount = this.fileCount;
    return cloned;
  }

  getCurrentStateConfig(): StateMachineConfig['states'][State] {
    return this.config.states[this.currentState];
  }

  getAllowedTools(): AgentTool[] {
    const stateConfig = this.getCurrentStateConfig();
    const allowedSet = new Set(stateConfig.allowedTools);
    return this.allTools.filter((tool) => allowedSet.has(tool.name));
  }

  transitionTo(nextState: State): void {
    const expected = getNextState(this.currentState, true);
    if (expected !== nextState && !(this.currentState === State.REASON && nextState === State.REASON))
      console.warn('[session] Unexpected transition:', this.currentState, '->', nextState, '(expected', expected + ')');
    this.currentState = nextState;
  }

  recordToolCall(tool: string): void {
    if (tool === 'edit' || tool === 'write') {
      this.fileCount++;
    }
  }

  getCurrentState(): State {
    return this.currentState;
  }

  canModifyMoreFiles(maxFiles?: number): boolean {
    const limit = maxFiles ?? this.config.modelParams.maxFilesPerTask;
    return this.fileCount < limit;
  }

  getFileCount(): number {
    return this.fileCount;
  }

  resetForRetry(): void {
    this.currentState = State.REASON;
    this.fileCount = 0;
  }

  resetForNextTask(nextState: State): void {
    this.currentState = nextState;
    this.fileCount = 0;
  }

  getModelParams(): ModelParams {
    return this.config.modelParams;
  }
}
