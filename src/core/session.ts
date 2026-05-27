import { codingTools, grepTool, lsTool, findTool } from '@mariozechner/pi-coding-agent';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { State, type StateMachineConfig, type StateContext, type ToolCall, type ModelParams } from './types.js';
import { detectModelParams, getBaseStateConfigs } from './states.js';
import { createStateContext } from './logic.js';
import { buildSystemPrompt } from './prompts/index.js';

/**
 * State machine controlled agent
 * Deterministic pipeline with constrained LLM
 */
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

  constructor(modelName: string, extraTools: AgentTool<any, any>[] = [], paramCount: number | null = null) {
    this.modelName = modelName;
    this.extraTools = extraTools;
    this.paramCount = paramCount;
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
      ...codingTools,
      grepTool as AgentTool<any, any>,
      lsTool as AgentTool<any, any>,
      findTool as AgentTool<any, any>,
      ...extraTools,
    ];
  }

  clone(): StateMachineAgent {
    return new StateMachineAgent(this.modelName, this.extraTools, this.paramCount);
  }

  /**
   * Get current state configuration
   */
  getCurrentStateConfig(): StateMachineConfig['states'][State] {
    return this.config.states[this.currentState];
  }

  /**
   * Get allowed tools for current state
   */
  getAllowedTools(): AgentTool[] {
    const stateConfig = this.getCurrentStateConfig();
    return this.allTools.filter((tool) => stateConfig.allowedTools.includes(tool.name));
  }

  /**
   * Generate prompt for current state
   */
  generatePrompt(task: string): string {
    const context = this.createContext(task);
    return buildSystemPrompt({
      state: this.currentState,
      task,
      modelParams: this.config.modelParams,
      context,
    });
  }

  /**
   * Create context for LLM
   */
  createContext(task: string): StateContext {
    const stateConfig = this.getCurrentStateConfig();
    const context = createStateContext(this.currentState, task, stateConfig);
    context.availableTools = this.getAllowedTools();
    return context;
  }

  /**
   * Transition to next state
   */
  transitionTo(nextState: State): void {
    if (this.config.onStateChange) {
      this.config.onStateChange(this.currentState, nextState);
    }
    this.currentState = nextState;
    this.stateIteration = 0;
  }

  /**
   * Record tool call
   */
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

    // Track file modifications
    if (tool === 'edit' || tool === 'write') {
      this.fileCount++;
    }
  }

  /**
   * Increment iteration counter
   */
  incrementIteration(): void {
    this.stateIteration++;
  }

  /**
   * Get current state
   */
  getCurrentState(): State {
    return this.currentState;
  }

  /**
   * Get iteration count
   */
  getIteration(): number {
    return this.stateIteration;
  }

  /**
   * Check if can modify more files
   */
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
  }

  getModelParams(): ModelParams {
    return this.config.modelParams;
  }
}
