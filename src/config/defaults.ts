import type { Config, ModelConfig, SystemConfig, RuntimeConfig, StateMachineConfig, TaskConfig, SafetyConfig, DecompositionConfig, FailureHandlingConfig } from './types.js';
import type { HardwareConstraints } from '../sysinfo/types.js';
import { getSysInfo, calculateHardwareConstraints } from '../sysinfo/collector.js';

/**
 * Get default model configuration
 */
function getDefaultModelConfig(hardware: HardwareConstraints): ModelConfig {
  return {
    provider: 'ollama',
    model: `qwen2.5:${hardware.recommendedModelSize.toLowerCase()}`,
    baseUrl: 'http://localhost:11434',
    contextLength: hardware.recommendedContextLength,
    temperature: 0.1,
    maxTokens: 2048,
  };
}

/**
 * Get default task configuration
 */
function getDefaultTaskConfig(): TaskConfig {
  return {
    maxRetries: 3,
    operationTimeoutMs: 30000,
    enableCheckpoints: true,
    checkpointDir: '.local-agent/checkpoints',
  };
}

/**
 * Get default system configuration
 */
function getDefaultSystemConfig(hardware: HardwareConstraints): SystemConfig {
  return {
    model: getDefaultModelConfig(hardware),
    task: getDefaultTaskConfig(),
    hardware,
    logLevel: 'info',
  };
}

/**
 * Get default runtime configuration
 */
function getDefaultRuntimeConfig(hardware: HardwareConstraints): RuntimeConfig {
  return {
    currentVramUsage: 0,
    currentRamUsage: 0,
    pauseNewTasks: false,
    adjustedContextLength: hardware.recommendedContextLength,
  };
}

/**
 * Get default state machine configuration
 */
function getDefaultStateMachineConfig(): StateMachineConfig {
  return {
    maxIterations: 50,
    maxTurnsPerState: 5,
    maxTotalTurns: 25,
    enableStagnationDetector: true,
    enableCompaction: true,
    compactionThreshold: 3000,
  };
}

function getDefaultSafetyConfig(): SafetyConfig {
  return {
    enableCheckpoint: true,
    enablePostCheck: true,
    maxLinesPerEdit: 30,
    maxFilesPerTask: 4,
  };
}

function getDefaultDecompositionConfig(): DecompositionConfig {
  return {
    enableLevel1: true,
    enableLevel2: false,
    level2MaxTokens: 500,
    maxSubTasks: 6,
  };
}

function getDefaultFailureHandlingConfig(): FailureHandlingConfig {
  return {
    maxRetries: 3,
    enableHumanIntervention: true,
  };
}

/**
 * Get default configuration based on hardware detection
 */
export function getDefaultConfig(): Config {
  const sysInfo = getSysInfo();
  const hardware = calculateHardwareConstraints(sysInfo);

  return {
    system: getDefaultSystemConfig(hardware),
    runtime: getDefaultRuntimeConfig(hardware),
    stateMachine: getDefaultStateMachineConfig(),
    safety: getDefaultSafetyConfig(),
    decomposition: getDefaultDecompositionConfig(),
    failureHandling: getDefaultFailureHandlingConfig(),
  };
}

/**
 * Merge user configuration with defaults
 */
export function mergeWithDefaults(userConfig: Partial<Config>): Config {
  const defaults = getDefaultConfig();

  return {
    system: {
      ...defaults.system,
      ...userConfig.system,
      model: {
        ...defaults.system.model,
        ...userConfig.system?.model,
      },
      task: {
        ...defaults.system.task,
        ...userConfig.system?.task,
      },
    },
    runtime: {
      ...defaults.runtime,
      ...userConfig.runtime,
    },
    stateMachine: {
      ...defaults.stateMachine,
      ...userConfig.stateMachine,
    },
    safety: {
      ...defaults.safety,
      ...userConfig.safety,
    },
    decomposition: {
      ...defaults.decomposition,
      ...userConfig.decomposition,
    },
    failureHandling: {
      ...defaults.failureHandling,
      ...userConfig.failureHandling,
    },
  };
}
