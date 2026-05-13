import { codingTools } from '@mariozechner/pi-coding-agent';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import {
  State,
  type StateMachineConfig,
  type StateResult,
  type StateContext,
  type ToolCall,
  type ModelParams,
} from './types.js';
import { detectModelParams, getBaseStateConfigs, generateAdaptivePrompt } from './states.js';
import { checkExitCondition, createStateContext, formatToolCallsForContext } from './logic.js';
import { PromptBuilder } from '../provider/prompt.js';

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
  private promptBuilder: PromptBuilder;

  constructor(modelName: string, extraTools: AgentTool<any, any>[] = []) {
    const modelParams = detectModelParams(modelName);
    const states = getBaseStateConfigs();

    this.config = {
      modelParams,
      states,
    };

    this.currentState = State.ANALYZE;
    this.stateIteration = 0;
    this.toolCalls = [];
    this.fileCount = 0;
    this.allTools = [...codingTools, ...extraTools];
    this.promptBuilder = new PromptBuilder();
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
    return this.allTools.filter((tool) =>
      stateConfig.allowedTools.includes(tool.name),
    );
  }

  /**
   * Generate prompt for current state
   */
  generatePrompt(task: string): string {
    const context = this.createContext(task);
    return this.promptBuilder.buildSystemPrompt({
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
   * Check if should exit current state
   */
  checkExit(llmOutput: string): { shouldExit: boolean; nextState: State; reason: string } {
    const stateConfig = this.getCurrentStateConfig();
    const result = checkExitCondition(
      this.currentState,
      this.stateIteration,
      stateConfig.maxIterations,
      llmOutput,
    );
    return {
      shouldExit: result.shouldExit,
      nextState: result.nextState,
      reason: result.reason,
    };
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
  canModifyMoreFiles(): boolean {
    return this.fileCount < this.config.modelParams.maxFilesPerTask;
  }

  /**
   * Get model params
   */
  getModelParams(): ModelParams {
    return this.config.modelParams;
  }
}
