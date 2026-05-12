import type { ToolCall } from '../types.js';

/**
 * Stagnation detection configuration
 */
export interface CognitiveGateConfig {
  maxRepeatedToolCalls: number;
  maxRepeatedErrors: number;
  similarityThreshold: number;
  onIneffectiveLoop?: (detection: IneffectiveLoopDetection) => void;
}

/**
 * Ineffective loop detection result
 */
export interface IneffectiveLoopDetection {
  detected: boolean;
  type: 'repeated_tool' | 'repeated_error' | 'no_progress';
  message: string;
  suggestion: string;
  toolCalls: ToolCall[];
}

/**
 * Stagnation detection — identifies and stops ineffective agent loops
 */
export class CognitiveGate {
  private config: CognitiveGateConfig;
  private toolCallHistory: ToolCall[];
  private errorHistory: string[];

  constructor(config: Partial<CognitiveGateConfig> = {}) {
    this.config = {
      maxRepeatedToolCalls: 3,
      maxRepeatedErrors: 2,
      similarityThreshold: 0.8,
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
    // Check for repeated tool calls
    const repeatedTool = this.detectRepeatedToolCalls();
    if (repeatedTool.detected) {
      return repeatedTool;
    }

    // Check for repeated errors
    const repeatedError = this.detectRepeatedErrors();
    if (repeatedError.detected) {
      return repeatedError;
    }

    // Check for no progress
    const noProgress = this.detectNoProgress();
    if (noProgress.detected) {
      return noProgress;
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

    const allSame = recent.every(
      (call) => call.tool === first.tool &&
        JSON.stringify(call.input) === JSON.stringify(first.input)
    );

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
export function createCognitiveGate(config?: Partial<CognitiveGateConfig>): CognitiveGate {
  return new CognitiveGate(config);
}
