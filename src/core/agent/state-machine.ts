import { createCodingTools, createGrepTool, createLsTool, createFindTool } from '@earendil-works/pi-coding-agent';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { State, type ModelParams } from '../types.js';
import { STATE_REGISTRY } from '../state-registry.js';

/**
 * The one home of the model-tier thresholds (≤9B SMALL, ≤30B MEDIUM, else
 * LARGE). The TUI's pre-run header consumes this too — it used to re-derive
 * the thresholds inline and its copy had already drifted in casing
 * ('small' vs 'SMALL') (round-4, candidate 4).
 */
export function tierForParams(billions: number): ModelParams['tier'] {
  if (billions <= 9) return 'SMALL';
  if (billions <= 30) return 'MEDIUM';
  return 'LARGE';
}

export function detectModelParams(paramCount: number | null): ModelParams {
  const billions = paramCount !== null ? paramCount / 1e9 : null;
  if (billions === null) {
    return { tier: 'LARGE' };
  }
  const tier = tierForParams(billions);
  if (tier === 'SMALL') {
    return { tier };
  }
  if (tier === 'MEDIUM') {
    return { tier };
  }
  return { tier };
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
    extraTools: AgentTool[] = [],
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
      createGrepTool(projectRoot),
      createLsTool(projectRoot),
      createFindTool(projectRoot),
      ...extraTools,
    ];
  }

  clone(): StateMachineAgent {
    // Parallel-branch clone: independent file-count budget (per-branch limit)
    // and independent currentState — runStep resets both at entry anyway.
    return new StateMachineAgent(this.modelName, [...this.extraTools], this.paramCount, this.projectRoot);
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

  canModifyMoreFiles(maxFiles: number): boolean {
    return this.fileCount < maxFiles;
  }

  getFileCount(): number {
    return this.fileCount;
  }

  /**
   * Reset the per-step file budget for a retry. Named honestly (round-5
   * hygiene): this used to also write currentState = REASON — a dead write
   * with no reader (tool gating is read before driving; the next state is
   * set by resetForNextTask / runReasonAttempt), and a misleading one on
   * non-REASON steps' retries.
   */
  resetFileBudget(): void {
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
