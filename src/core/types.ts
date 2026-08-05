/**
 * State machine types for mu-agent — interfaces are kept at their read
 * surface (round-8, candidate 1: members with zero readers are deleted,
 * not documented).
 */

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

/** Model parameters for adaptive constraints — tier is the only living
 *  dimension (retry budget is a constant at its one read site; strictPlanning
 *  and paramCount had zero readers — round-8, candidate 1). */
export interface ModelParams {
  tier: ModelTier;
}

/** Result of a full run — exactly what cli/tui/memory consume. */
export interface StateResult {
  success: boolean;
  output: string;
}

/** Tool call record — the stagnation detector compares tool+input only. */
export interface ToolCall {
  tool: string;
  input: unknown;
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
