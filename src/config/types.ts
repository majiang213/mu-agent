/**
 * Configuration types for local-agent
 */

import type { HardwareConstraints } from '../sysinfo/types.js';

/**
 * Model provider configuration
 */
export interface ModelConfig {
  /** Provider type */
  provider: 'ollama' | 'openai' | 'custom';
  /** Model name */
  model: string;
  /** Base URL for API */
  baseUrl: string;
  /** API key (if required) */
  apiKey?: string;
  /** Context length */
  contextLength: number;
  /** Temperature for generation */
  temperature: number;
  /** Maximum tokens per request */
  maxTokens: number;
}

/**
 * Task execution configuration
 */
export interface TaskConfig {
  /** Maximum retries for failed operations */
  maxRetries: number;
  /** Timeout for operations in milliseconds */
  operationTimeoutMs: number;
  /** Enable checkpointing */
  enableCheckpoints: boolean;
  /** Checkpoint directory */
  checkpointDir: string;
}

/**
 * System configuration
 */
export interface SystemConfig {
  /** Model configuration */
  model: ModelConfig;
  /** Task execution configuration */
  task: TaskConfig;
  /** Hardware constraints (auto-detected or manual) */
  hardware: HardwareConstraints;
  /** Logging level */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * Runtime configuration that can be updated dynamically
 */
export interface RuntimeConfig {
  /** Current VRAM usage percentage */
  currentVramUsage: number;
  /** Current RAM usage percentage */
  currentRamUsage: number;
  /** Whether to pause new tasks */
  pauseNewTasks: boolean;
  /** Adjusted context length based on current load */
  adjustedContextLength: number;
}

/**
 * Configuration for state machine
 */
export interface StateMachineConfig {
  maxIterations: number;
  maxTurnsPerState: number;
  maxTotalTurns: number;
  enableStagnationDetector: boolean;
  enableCompaction: boolean;
  compactionThreshold: number;
}

/**
 * Safety modification configuration
 */
export interface SafetyConfig {
  enableCheckpoint: boolean;
  enablePostCheck: boolean;
  maxLinesPerEdit: number;
  maxFilesPerTask: number;
}

/**
 * Task decomposition configuration
 */
export interface DecompositionConfig {
  enableLevel1: boolean;
  enableLevel2: boolean;
  level2MaxTokens: number;
  maxSteps: number;
}

/**
 * Failure handling configuration
 */
export interface FailureHandlingConfig {
  maxRetries: number;
  enableHumanIntervention: boolean;
}

/**
 * Complete configuration object
 */
export interface Config {
  system: SystemConfig;
  runtime: RuntimeConfig;
  stateMachine: StateMachineConfig;
  safety: SafetyConfig;
  decomposition: DecompositionConfig;
  failureHandling: FailureHandlingConfig;
}
