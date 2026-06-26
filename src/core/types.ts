/**
 * State machine types for mu-agent
 * Based on architecture design: deterministic pipeline + constrained LLM
 */

import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';

export interface SteerMessage {
  role: 'steer';
  content: string;
  timestamp: number;
}

declare module '@earendil-works/pi-agent-core' {
  interface CustomAgentMessages {
    steer: SteerMessage;
  }
}

/** Core states for coding tasks */
export enum State {
  LOCATE = 'LOCATE',
  MODIFY = 'MODIFY',
  VERIFY = 'VERIFY',
  DONE = 'DONE',
  REASON = 'REASON',
  CLARIFY = 'CLARIFY',
  ANSWER = 'ANSWER',
  DIAGNOSE = 'DIAGNOSE',
  REVIEW = 'REVIEW',
  TEST_WRITE = 'TEST_WRITE',
  REFACTOR_PLAN = 'REFACTOR_PLAN',
  ROLLBACK = 'ROLLBACK',
  RESEARCH = 'RESEARCH',
  SETUP = 'SETUP',
  WRITE = 'WRITE',
  PLAN = 'PLAN',
  GIT = 'GIT',
}

export interface SubplanSpec {
  analyzerState: State;
  focus: string;
}

/** Model capability tiers */
export type ModelTier = 'SMALL' | 'MEDIUM' | 'LARGE';

/** Model parameters for adaptive constraints */
export interface ModelParams {
  tier: ModelTier;
  paramCount: number;
  maxFilesPerTask: number;
  maxRetries: number;
  strictPlanning: boolean;
}

/** State configuration */
export interface StateConfig {
  name: State;
  allowedTools: string[];
}

/** State context passed to LLM */
export interface StateContext {
  state: State;
  task: string;
  history: StateResult[];
  availableTools: AgentTool[];
}

/** Result from state execution */
export interface StateResult {
  state: State;
  success: boolean;
  output: string;
  toolCalls: ToolCall[];
  nextState: State;
  messages?: AgentMessage[];
}

/** Tool call record */
export interface ToolCall {
  tool: string;
  input: unknown;
  output: unknown;
  timestamp: number;
}

/** State machine configuration */
/** A single execution step in the agent's dynamic plan (from REASON output) */
export interface Step {
  state: State;
  focus: string;
  /** Optional: reasoning behind this step — why this state, why this approach.
   *  Max ~15 words. Only filled during heavy thinking sampling for deliberation use. */
  why?: string;
}

/** A Step that has been executed — output is guaranteed to be present */
export interface ExecutedStep extends Step {
  output: string;
}

/**
 * A directive in the REASON output plan.
 * Either a single Step (sequential execution) or a parallel group
 * (multiple independent steps executed concurrently with isolated state machines).
 */
export type StepDirective = Step | { parallel: Step[] } | { subplan: SubplanSpec };

export const STATES_NEEDING_CODE_CONTEXT = new Set([
  State.LOCATE,
  State.RESEARCH,
  State.DIAGNOSE,
  State.REVIEW,
  State.REFACTOR_PLAN,
]);
