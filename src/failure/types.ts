/**
 * Failure handling types
 */

/** Failure types */
export type FailureType =
  | 'tool_execution'
  | 'llm_error'
  | 'timeout'
  | 'validation'
  | 'unknown';

/** Recovery level */
export type RecoveryLevel = 1 | 2 | 3 | 4;

/** Failure context */
export interface FailureContext {
  type: FailureType;
  error: Error;
  state: string;
  attempt: number;
  maxAttempts: number;
  metadata?: Record<string, unknown>;
}

/** Recovery strategy */
export interface RecoveryStrategy {
  level: RecoveryLevel;
  name: string;
  canHandle: (context: FailureContext) => boolean;
  execute: (context: FailureContext) => Promise<RecoveryResult>;
}

/** Recovery result */
export interface RecoveryResult {
  success: boolean;
  action: string;
  newContext?: Partial<FailureContext>;
  shouldRetry: boolean;
  message: string;
}

/** Failure handler config */
export interface FailureHandlerConfig {
  maxRetries: number;
  backoffMultiplier: number;
  onLevelChange?: (level: RecoveryLevel) => void;
  onHumanIntervention?: (context: FailureContext) => void;
}
