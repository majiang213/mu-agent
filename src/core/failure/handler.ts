import {
  type FailureContext,
  type FailureHandlerConfig,
  type RecoveryResult,
  type RecoveryLevel,
} from './types.js';
import { getDefaultStrategies, findStrategy } from './strategies.js';

/**
 * Failure handler with four-level recovery strategy
 */
export class FailureHandler {
  private config: FailureHandlerConfig;
  private currentLevel: RecoveryLevel;

  constructor(config: Partial<FailureHandlerConfig> = {}) {
    this.config = {
      maxRetries: 3,
      backoffMultiplier: 2,
      ...config,
    };
    this.currentLevel = 1;
  }

  /**
   * Handle failure with appropriate recovery strategy
   */
  async handleFailure(context: FailureContext): Promise<RecoveryResult> {
    const strategies = getDefaultStrategies();
    const strategy = findStrategy(context, strategies);

    if (!strategy) {
      return {
        success: false,
        action: 'no_strategy_found',
        shouldRetry: false,
        message: 'No recovery strategy available for this failure',
      };
    }

    // Update current level
    if (strategy.level !== this.currentLevel) {
      this.currentLevel = strategy.level;
      this.config.onLevelChange?.(this.currentLevel);
    }

    // Execute strategy
    const result = await strategy.execute(context);

    // Notify if human intervention needed
    if (strategy.level === 4 && this.config.onHumanIntervention) {
      this.config.onHumanIntervention(context);
    }

    return result;
  }

  /**
   * Check if should retry
   */
  shouldRetry(context: FailureContext): boolean {
    return context.attempt < context.maxAttempts;
  }

  /**
   * Create failure context
   */
  createContext(
    type: FailureContext['type'],
    error: Error,
    state: string,
    attempt: number,
    metadata?: Record<string, unknown>,
  ): FailureContext {
    return {
      type,
      error,
      state,
      attempt,
      maxAttempts: this.config.maxRetries,
      metadata,
    };
  }

  /**
   * Get current recovery level
   */
  getCurrentLevel(): RecoveryLevel {
    return this.currentLevel;
  }

  /**
   * Reset to level 1
   */
  reset(): void {
    this.currentLevel = 1;
  }
}

/**
   * Create failure handler instance
   */
export function createFailureHandler(config?: Partial<FailureHandlerConfig>): FailureHandler {
  return new FailureHandler(config);
}
