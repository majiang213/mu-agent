/**
 * Modification limits based on safety level
 */
export interface ModificationLimits {
  maxLines: number;
  maxFunctions: number;
  maxFiles: number;
}

/**
 * Safety levels
 */
export type SafetyLevel = 'default' | 'strict';

/**
 * Line limit checker
 */
export class LineLimitChecker {
  private limits: Record<SafetyLevel, ModificationLimits> = {
    default: {
      maxLines: 30,
      maxFunctions: 2,
      maxFiles: 2,
    },
    strict: {
      maxLines: 10,
      maxFunctions: 1,
      maxFiles: 1,
    },
  };

  /**
   * Check if modification is within limits
   */
  check(
    originalContent: string,
    modifiedContent: string,
    level: SafetyLevel = 'default',
  ): { allowed: boolean; reason?: string } {
    const limits = this.limits[level];

    const originalLines = originalContent.split('\n').length;
    const modifiedLines = modifiedContent.split('\n').length;
    const lineDiff = Math.abs(modifiedLines - originalLines);

    if (lineDiff > limits.maxLines) {
      return {
        allowed: false,
        reason: `Modification too large: ${lineDiff} lines changed (max ${limits.maxLines})`,
      };
    }

    // Count functions in diff
    const functionChanges = this.countFunctionChanges(originalContent, modifiedContent);
    if (functionChanges > limits.maxFunctions) {
      return {
        allowed: false,
        reason: `Too many functions modified: ${functionChanges} (max ${limits.maxFunctions})`,
      };
    }

    return { allowed: true };
  }

  /**
   * Count function changes
   */
  private countFunctionChanges(original: string, modified: string): number {
    const functionPattern = /(?:function|const|let|var)\s+(\w+)\s*[(=]/g;

    const originalFunctions = new Set<string>();
    for (const match of original.matchAll(functionPattern)) {
      if (match[1]) originalFunctions.add(match[1]);
    }

    const modifiedFunctions = new Set<string>();
    for (const match of modified.matchAll(functionPattern)) {
      if (match[1]) modifiedFunctions.add(match[1]);
    }

    // Count differences
    let changes = 0;
    for (const func of originalFunctions) {
      if (!modifiedFunctions.has(func)) {
        changes++;
      }
    }
    for (const func of modifiedFunctions) {
      if (!originalFunctions.has(func)) {
        changes++;
      }
    }

    return changes;
  }

  /**
   * Get limits for level
   */
  getLimits(level: SafetyLevel): ModificationLimits {
    return this.limits[level];
  }
}

/**
 * Create line limit checker
 */
export function createLineLimitChecker(): LineLimitChecker {
  return new LineLimitChecker();
}
