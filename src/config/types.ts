/**
 * Configuration types for mu-agent
 */

export interface ModelConfig {
  /** Provider type */
  provider: 'ollama' | 'custom' | 'unsloth';
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
  /** Model size in billions of parameters, e.g. 7 for a 7B model (custom provider only).
   *  Determines tier: ≤9 → SMALL, ≤30 → MEDIUM, >30 → LARGE. */
  modelSize?: number;
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
  /** Set to false to disable Heavy Thinking regardless of model tier. Default: true. */
  enabled?: boolean;
  planCount?: number;
  samplingTemperature?: number;
  deliberationModel?: string;
}

/** Valid logging verbosity levels for the agent runtime. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface Config {
  $schema?: string;
  model: ModelConfig;
  safety?: SafetyConfig;
  heavyThinking?: HeavyThinkingConfig;
  /** Logging verbosity, default 'info'. */
  logLevel?: LogLevel;
}
