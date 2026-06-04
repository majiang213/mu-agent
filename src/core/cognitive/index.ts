import type { ToolCall } from '../types.js';

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const ba = b as unknown[];
    if (a.length !== ba.length) return false;
    return (a as unknown[]).every((v, i) => deepEqual(v, ba[i]));
  }
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Stagnation detection configuration
 */
export interface StagnationDetectorConfig {
  maxRepeatedToolCalls: number;
  maxRepeatedErrors: number;
  similarityThreshold: number;
  cycleWindowSize: number;
  checkNoProgress: boolean;
  onIneffectiveLoop?: (detection: IneffectiveLoopDetection) => void;
}

/**
 * Ineffective loop detection result
 */
export interface IneffectiveLoopDetection {
  detected: boolean;
  type: 'repeated_tool' | 'repeated_error' | 'no_progress' | 'cycle';
  message: string;
  suggestion: string;
  toolCalls: ToolCall[];
}

/**
 * Stagnation detection — identifies and stops ineffective agent loops
 */
export class StagnationDetector {
  private config: StagnationDetectorConfig;
  private toolCallHistory: ToolCall[];
  private errorHistory: string[];

  constructor(config: Partial<StagnationDetectorConfig> = {}) {
    this.config = {
      maxRepeatedToolCalls: 3,
      maxRepeatedErrors: 2,
      similarityThreshold: 0.8,
      cycleWindowSize: 4,
      checkNoProgress: true,
      ...config,
    };
    this.toolCallHistory = [];
    this.errorHistory = [];
  }

  /**
   * Record tool call for analysis
   */
  recordToolCall(call: ToolCall): void {
    this.toolCallHistory.push(call);
  }

  /**
   * Record error for analysis
   */
  recordError(error: string): void {
    this.errorHistory.push(error);
  }

  /**
   * Check for ineffective loops
   */
  check(): IneffectiveLoopDetection {
    const repeatedTool = this.detectRepeatedToolCalls();
    if (repeatedTool.detected) return repeatedTool;

    const repeatedError = this.detectRepeatedErrors();
    if (repeatedError.detected) return repeatedError;

    const cycle = this.detectCycle();
    if (cycle.detected) return cycle;

    if (this.config.checkNoProgress) {
      const noProgress = this.detectNoProgress();
      if (noProgress.detected) return noProgress;
    }

    return {
      detected: false,
      type: 'no_progress',
      message: 'No ineffective loop detected',
      suggestion: 'Continue with current approach',
      toolCalls: [],
    };
  }

  /**
   * Detect repeated tool calls
   */
  private detectRepeatedToolCalls(): IneffectiveLoopDetection {
    if (this.toolCallHistory.length < this.config.maxRepeatedToolCalls) {
      return { detected: false } as IneffectiveLoopDetection;
    }

    const recent = this.toolCallHistory.slice(-this.config.maxRepeatedToolCalls);
    const first = recent[0];
    if (!first) return { detected: false } as IneffectiveLoopDetection;

    const allSame = recent.every((call) => call.tool === first.tool && deepEqual(call.input, first.input));

    if (allSame) {
      return {
        detected: true,
        type: 'repeated_tool',
        message: `Repeated ${first.tool} calls detected`,
        suggestion: 'Try a different approach or ask for clarification',
        toolCalls: recent,
      };
    }

    return { detected: false } as IneffectiveLoopDetection;
  }

  private detectCycle(): IneffectiveLoopDetection {
    const w = this.config.cycleWindowSize;
    if (this.toolCallHistory.length < w * 2) {
      return { detected: false } as IneffectiveLoopDetection;
    }

    const history = this.toolCallHistory;
    const len = history.length;

    for (let size = 2; size <= w; size++) {
      const a = history.slice(len - size * 2, len - size);
      const b = history.slice(len - size, len);
      const isCycle = a.every((call, i) => call.tool === b[i]!.tool && deepEqual(call.input, b[i]!.input));
      if (isCycle) {
        const toolNames = a.map((c) => c.tool).join(' → ');
        return {
          detected: true,
          type: 'cycle',
          message: `Repeating tool sequence detected (${size} steps): ${toolNames}`,
          suggestion: 'Break the cycle: try a different tool, different input, or call complete()',
          toolCalls: [...a, ...b],
        };
      }
    }

    return { detected: false } as IneffectiveLoopDetection;
  }

  /**
   * Detect repeated errors
   */
  private detectRepeatedErrors(): IneffectiveLoopDetection {
    if (this.errorHistory.length < this.config.maxRepeatedErrors) {
      return { detected: false } as IneffectiveLoopDetection;
    }

    const recent = this.errorHistory.slice(-this.config.maxRepeatedErrors);
    const allSame = recent.every((err) => err === recent[0]);

    if (allSame) {
      return {
        detected: true,
        type: 'repeated_error',
        message: `Same error repeated: ${recent[0]}`,
        suggestion: 'Stop and analyze the root cause before retrying',
        toolCalls: [],
      };
    }

    return { detected: false } as IneffectiveLoopDetection;
  }

  /**
   * Detect no progress situation
   */
  private detectNoProgress(): IneffectiveLoopDetection {
    if (this.toolCallHistory.length < 5) {
      return { detected: false } as IneffectiveLoopDetection;
    }

    // Check if last 5 tool calls are all reads without modifications
    const recent = this.toolCallHistory.slice(-5);
    const allReads = recent.every((call) => call.tool === 'read');

    if (allReads) {
      return {
        detected: true,
        type: 'no_progress',
        message: 'Only reading files without making changes',
        suggestion: 'Either make the modification or ask for clarification',
        toolCalls: recent,
      };
    }

    return { detected: false } as IneffectiveLoopDetection;
  }

  /**
   * Reset history
   */
  reset(): void {
    this.toolCallHistory = [];
    this.errorHistory = [];
  }

  /**
   * Get statistics
   */
  getStats(): { toolCalls: number; errors: number } {
    return {
      toolCalls: this.toolCallHistory.length,
      errors: this.errorHistory.length,
    };
  }
}

/**
 * Create stagnation detector
 */
export function createStagnationDetector(config?: Partial<StagnationDetectorConfig>): StagnationDetector {
  return new StagnationDetector(config);
}
