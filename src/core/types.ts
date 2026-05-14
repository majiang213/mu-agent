/**
 * State machine types for local-agent
 * Based on architecture design: deterministic pipeline + constrained LLM
 */

import type { AgentMessage, AgentTool } from '@mariozechner/pi-agent-core';

/** Core states for coding tasks */
export enum State {
  ANALYZE = 'ANALYZE',
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
  RUN = 'RUN',
  RESEARCH = 'RESEARCH',
  SETUP = 'SETUP',
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
  prompt: string;
  maxIterations: number;
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
export interface StateMachineConfig {
  modelParams: ModelParams;
  states: Record<State, StateConfig>;
  onStateChange?: (from: State, to: State) => void;
  onToolCall?: (call: ToolCall) => void;
}

/** Exit condition check result */
export interface ExitCheckResult {
  shouldExit: boolean;
  reason: string;
  nextState: State;
}

/** Task type for decomposition classification */
export type IntentType =
  | 'CODING'
  | 'BUGFIX'
  | 'REFACTORING'
  | 'TESTING'
  | 'DOCUMENTATION'
  | 'REVIEW'
  | 'ANALYSIS'
  | 'QUESTION'
  | 'RUN'
  | 'RESEARCH'
  | 'SETUP'
  | 'UNKNOWN';

/** A single execution step produced by the Planner */
export interface Step {
  id: string;
  description: string;
  type: IntentType;
  dependencies: string[];
  parallel?: boolean;
  parallelGroup?: string;
}

/** Result from the Planner */
export interface DecompositionResult {
  tasks: Step[];
  level: 1 | 2 | 3;
  confidence: number;
}

/** An item in the agent's agenda (step + its execution trajectory) */
export interface AgendaItem {
  step: Step;
  trajectory: State[];
  status: 'pending' | 'running' | 'done' | 'failed';
}
