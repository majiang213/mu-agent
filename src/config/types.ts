/**
 * Configuration types for mu-agent
 */

import type { ProviderName } from '../provider/providers.js';

export interface ModelConfig {
  /** Provider type — vocabulary lives in provider/providers.ts (PROVIDER_FACTS) */
  provider: ProviderName;
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
  /** Max files modified per task, default 5 */
  maxFilesPerTask?: number;
}

export interface HeavyThinkingConfig {
  /** Set to false to disable Heavy Thinking regardless of model tier. Default: true. */
  enabled?: boolean;
  samplingTemperature?: number;
  deliberationModel?: string;
}

/**
 * User extension system (Gap 85-A). Discovery: `<project>/.mu-agent/extensions/`
 * + `~/.mu-agent/extensions/` + `paths`. `.pi/extensions` is NOT scanned
 * implicitly — bridge pi extensions by listing them in `paths`.
 */
export interface ExtensionsConfig {
  /** Master switch, default true (zero cost when no extension dirs exist). */
  enabled?: boolean;
  /** Extra extension files/dirs (relative paths resolve against project root). */
  paths?: string[];
  /**
   * States that receive extension-registered tools. Default:
   * RESEARCH/DIAGNOSE/REVIEW/ANSWER. REASON/MODIFY/VERIFY are hard-excluded
   * (small-model discipline + no checkpoint bypass) even if listed.
   */
  toolStates?: string[];
}

export interface Config {
  $schema?: string;
  model: ModelConfig;
  safety?: SafetyConfig;
  heavyThinking?: HeavyThinkingConfig;
  extensions?: ExtensionsConfig;
  /** pi theme name (Gap 87): "dark" | "light" | a theme file name from ~/.mu-agent/themes. Default: terminal auto-detect. */
  theme?: string;
}
