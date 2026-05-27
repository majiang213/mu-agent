/**
 * Configuration types for local-agent
 */

export interface ModelConfig {
  /** Provider type */
  provider: 'ollama' | 'custom';
  /** Model name, e.g. "qwen2.5:7b" */
  name: string;
  /** Base URL for API, e.g. "http://localhost:11434" */
  baseUrl: string;
  /** API key (required for custom provider) */
  apiKey?: string;
  /** Temperature for generation, default 0.1 */
  temperature?: number;
  /** Fraction of context window used for input before compaction triggers, default 0.75.
   *  Output maxTokens = contextWindow * (1 - contextRatio). */
  contextRatio?: number;
}

export interface ToolOutputConfig {
  /** Max lines to return from tool output, default 200 */
  maxLines?: number;
  /** Max bytes to return from tool output, default 51200 */
  maxBytes?: number;
}

export interface SafetyConfig {
  /** Enable file checkpointing before modification, default true */
  enableCheckpoint?: boolean;
  /** Max lines per edit operation, default 50 */
  maxLinesPerEdit?: number;
  /** Max files modified per task, default 5 */
  maxFilesPerTask?: number;
}

export interface HeavyThinkingConfig {
  planCount?: number;
  /** Temperature used for parallel plan sampling. Higher values (0.7) produce more diverse plans.
   *  Default 0.7. Set to model's generation temperature for RL-trained models (e.g. Qwen3, DeepSeek-R1). */
  samplingTemperature?: number;
}

export interface Config {
  $schema?: string;
  model: ModelConfig;
  toolOutput?: ToolOutputConfig;
  safety?: SafetyConfig;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  heavyThinking?: HeavyThinkingConfig;
}
