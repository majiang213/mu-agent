import { createCodingTools, createGrepTool, createLsTool, createFindTool } from '@earendil-works/pi-coding-agent';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { State, type ModelParams } from '../types.js';
import { STATE_REGISTRY } from '../state-registry.js';

export function detectModelParams(paramCount: number | null): ModelParams {
  const billions = paramCount !== null ? paramCount / 1e9 : null;

  if (billions !== null && billions <= 9) {
    return {
      tier: 'SMALL',
      paramCount: billions,
      maxFilesPerTask: 2,
      maxRetries: 1,
      strictPlanning: true,
    };
  } else if (billions !== null && billions <= 30) {
    return {
      tier: 'MEDIUM',
      paramCount: billions,
      maxFilesPerTask: 4,
      maxRetries: 2,
      strictPlanning: true,
    };
  } else {
    return {
      tier: 'LARGE',
      paramCount: billions ?? 0,
      maxFilesPerTask: 8,
      maxRetries: 3,
      strictPlanning: false,
    };
  }
}

/**
 * Per-task step environment: tool gating by state (from STATE_REGISTRY),
 * edit-file counting, and model tier params. The REASON-planned step list is
 * the control flow; this class only tracks the current state for tool gating.
 */
export class StateMachineAgent {
  private readonly modelParams: ModelParams;
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
    this.modelParams = detectModelParams(paramCount);

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

  getAllowedTools(): AgentTool[] {
    const allowedSet = new Set(STATE_REGISTRY[this.currentState]?.allowedTools ?? []);
    return this.allTools.filter((tool) => allowedSet.has(tool.name));
  }

  transitionTo(nextState: State): void {
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
    const limit = maxFiles ?? this.modelParams.maxFilesPerTask;
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
    return this.modelParams;
  }
}
