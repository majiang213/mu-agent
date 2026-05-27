import type { Config } from './types.js';

export const DEFAULT_TEMPERATURE = 0.1;
export const MAX_TEMPERATURE = 0.5;
export const RETRY_TEMPERATURE_STEP = 0.2;
export const DEFAULT_CONTEXT_RATIO = 0.75;
export const DEFAULT_SAMPLING_TEMPERATURE = 0.7;

export const DEFAULT_CONFIG: Config = {
  model: {
    provider: 'ollama',
    name: '',
    baseUrl: 'http://localhost:11434',
    temperature: 0.1,
  },
  toolOutput: {
    maxLines: 200,
    maxBytes: 51200,
  },
  safety: {
    enableCheckpoint: true,
    maxLinesPerEdit: 50,
    maxFilesPerTask: 5,
  },
  logLevel: 'info',
};

export function getDefaultConfig(): Config {
  return structuredClone(DEFAULT_CONFIG);
}

export function mergeWithDefaults(partial: Partial<Config>): Config {
  const defaults = getDefaultConfig();
  return {
    ...defaults,
    ...partial,
    model: {
      ...defaults.model,
      ...partial.model,
    },
    toolOutput: {
      ...defaults.toolOutput,
      ...partial.toolOutput,
    },
    safety: {
      ...defaults.safety,
      ...partial.safety,
    },
  };
}
