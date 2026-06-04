import { setTimeout } from 'node:timers/promises';
import { type FailureContext, type RecoveryResult, type RecoveryStrategy } from './types.js';

/**
 * Level 1: Retry with parameter adjustment
 */
export const level1RetryStrategy: RecoveryStrategy = {
  level: 1,
  name: 'retry_with_adjustment',
  canHandle: (ctx) => ctx.attempt < ctx.maxAttempts && ctx.type !== 'validation',
  execute: async (ctx): Promise<RecoveryResult> => {
    const backoffMs = Math.pow(2, ctx.attempt) * 1000;
    await setTimeout(backoffMs);

    return {
      success: true,
      action: 'retry_with_backoff',
      newContext: {
        attempt: ctx.attempt + 1,
      },
      shouldRetry: true,
      message: `Retrying after ${backoffMs}ms (attempt ${ctx.attempt + 1}/${ctx.maxAttempts})`,
    };
  },
};

/**
 * Level 2: Simplify task scope (triggers on second attempt)
 */
export const level2SimplifyStrategy: RecoveryStrategy = {
  level: 2,
  name: 'simplify_task',
  canHandle: (ctx) => ctx.attempt === 1,
  execute: async (): Promise<RecoveryResult> => {
    return {
      success: true,
      action: 'simplify_scope',
      newContext: {
        maxAttempts: 3,
      },
      shouldRetry: true,
      message: 'Reducing task scope and retrying',
    };
  },
};

/**
 * Level 3: Switch to larger model (triggers on third attempt)
 */
export const level3ModelSwitchStrategy: RecoveryStrategy = {
  level: 3,
  name: 'switch_model',
  canHandle: (ctx) => ctx.attempt >= 2 && ctx.attempt < ctx.maxAttempts,
  execute: async (): Promise<RecoveryResult> => {
    return {
      success: true,
      action: 'switch_to_larger_model',
      newContext: {
        metadata: { modelSwitched: true },
      },
      shouldRetry: true,
      message: 'Switching to larger model for better capability',
    };
  },
};

/**
 * Level 4: Human intervention
 */
export const level4HumanInterventionStrategy: RecoveryStrategy = {
  level: 4,
  name: 'human_intervention',
  canHandle: () => true,
  execute: async (ctx): Promise<RecoveryResult> => {
    return {
      success: false,
      action: 'request_human_help',
      shouldRetry: false,
      message: `Human intervention required: ${ctx.error.message}`,
    };
  },
};

/**
 * Get all strategies ordered by level
 */
export function getDefaultStrategies(): RecoveryStrategy[] {
  return [level1RetryStrategy, level2SimplifyStrategy, level3ModelSwitchStrategy, level4HumanInterventionStrategy];
}

/**
 * Find appropriate strategy for failure
 */
export function findStrategy(context: FailureContext, strategies: RecoveryStrategy[]): RecoveryStrategy | null {
  return strategies.find((s) => s.canHandle(context)) ?? null;
}
