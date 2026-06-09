import { createCodingTools, createGrepTool, createLsTool, createFindTool } from '@earendil-works/pi-coding-agent';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { State, type StateMachineConfig, type StateContext, type ToolCall, type ModelParams } from '../types.js';
import { detectModelParams, getBaseStateConfigs, getNextState } from '../states.js';
import { buildSystemPrompt } from '../prompts/index.js';

function createStateContext(
  state: State,
  task: string,
  _stateConfig: StateMachineConfig['states'][State],
): StateContext {
  return {
    state,
    task,
    history: [],
    availableTools: [],
  };
}

export class StateMachineAgent {
  private config: StateMachineConfig;
  private currentState: State;
  private stateIteration: number;
  private toolCalls: ToolCall[];
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
    this.stateIteration = 0;
    this.toolCalls = [];
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

  generatePrompt(task: string): string {
    const context = this.createContext(task);
    return buildSystemPrompt({
      state: this.currentState,
      task,
      modelParams: this.config.modelParams,
      context,
    });
  }

  createContext(task: string): StateContext {
    const stateConfig = this.getCurrentStateConfig();
    const context = createStateContext(this.currentState, task, stateConfig);
    context.availableTools = this.getAllowedTools();
    return context;
  }

  transitionTo(nextState: State): void {
    const expected = getNextState(this.currentState, true);
    if (expected !== nextState && !(this.currentState === State.REASON && nextState === State.REASON))
      console.warn('[session] Unexpected transition:', this.currentState, '->', nextState, '(expected', expected + ')');
    if (this.config.onStateChange) {
      this.config.onStateChange(this.currentState, nextState);
    }
    this.currentState = nextState;
    this.stateIteration = 0;
  }

  recordToolCall(tool: string, input: unknown, output: unknown): void {
    const call: ToolCall = {
      tool,
      input,
      output,
      timestamp: Date.now(),
    };
    this.toolCalls.push(call);

    if (this.config.onToolCall) {
      this.config.onToolCall(call);
    }

    if (tool === 'edit' || tool === 'write') {
      this.fileCount++;
    }
  }

  incrementIteration(): void {
    this.stateIteration++;
  }

  getCurrentState(): State {
    return this.currentState;
  }

  getIteration(): number {
    return this.stateIteration;
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
    this.stateIteration = 0;
    this.fileCount = 0;
    this.toolCalls = [];
  }

  resetForNextTask(nextState: State): void {
    this.currentState = nextState;
    this.stateIteration = 0;
    this.fileCount = 0;
    this.toolCalls = [];
  }

  getModelParams(): ModelParams {
    return this.config.modelParams;
  }
}
