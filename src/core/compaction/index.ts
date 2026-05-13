// Simple message interface for compaction
export interface CompactMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

/**
 * Context compaction configuration
 */
export interface CompactionConfig {
  maxTokens: number;
  preserveFirstN: number;
  preserveLastN: number;
  minMessagesToCompact: number;
}

/**
 * Compaction result
 */
export interface CompactionResult {
  compacted: boolean;
  originalCount: number;
  compactedCount: number;
  removedCount: number;
  summary?: string;
  messages?: CompactMessage[];
}

/**
 * Context compactor for managing token budget
 */
export class ContextCompactor {
  private config: CompactionConfig;

  constructor(config: Partial<CompactionConfig> = {}) {
    this.config = {
      maxTokens: 4000,
      preserveFirstN: 2,
      preserveLastN: 4,
      minMessagesToCompact: 10,
      ...config,
    };
  }

  /**
   * Check if compaction is needed
   */
  shouldCompact(messages: CompactMessage[]): boolean {
    if (messages.length < this.config.minMessagesToCompact) {
      return false;
    }

    const estimatedTokens = this.estimateTokens(messages);
    return estimatedTokens > this.config.maxTokens;
  }

  /**
   * Compact messages using head-tail strategy
   */
  compact(messages: CompactMessage[]): CompactionResult {
    if (!this.shouldCompact(messages)) {
      return {
        compacted: false,
        originalCount: messages.length,
        compactedCount: messages.length,
        removedCount: 0,
      };
    }

    const { preserveFirstN, preserveLastN } = this.config;
    const total = messages.length;

    // Keep head and tail
    const head = messages.slice(0, preserveFirstN);
    const tail = messages.slice(-preserveLastN);

    // Middle section to be compacted
    const middle = messages.slice(preserveFirstN, total - preserveLastN);

    // Create summary of middle section
    const summary = this.summarizeMessages(middle);

    // Build compacted messages
    const compacted: CompactMessage[] = [
      ...head,
      {
        role: 'system',
        content: `[Earlier context summarized]: ${summary}`,
      },
      ...tail,
    ];

    return {
      compacted: true,
      originalCount: total,
      compactedCount: compacted.length,
      removedCount: middle.length,
      summary,
      messages: compacted,
    };
  }

  /**
   * Estimate token count (rough approximation)
   */
  estimateTokens(messages: CompactMessage[]): number {
    // Rough estimate: 1 token ≈ 4 characters
    const totalChars = messages.reduce((sum, msg) => {
      const content = typeof msg.content === 'string' ? msg.content : '';
      return sum + content.length;
    }, 0);

    return Math.ceil(totalChars / 4);
  }

  /**
   * Summarize middle messages
   */
  private summarizeMessages(messages: CompactMessage[]): string {
    const summaries: string[] = [];

    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      const truncated = content.slice(0, 100);

      if (msg.role === 'user') {
        summaries.push(`User asked: "${truncated}..."`);
      } else if (msg.role === 'assistant') {
        summaries.push(`Assistant responded with ${content.length} chars`);
      } else if (msg.role === 'tool') {
        summaries.push('Tool execution');
      }
    }

    return summaries.join('; ');
  }

  /**
   * Get current config
   */
  getConfig(): CompactionConfig {
    return { ...this.config };
  }
}

/**
 * Create context compactor
 */
export function createContextCompactor(config?: Partial<CompactionConfig>): ContextCompactor {
  return new ContextCompactor(config);
}
