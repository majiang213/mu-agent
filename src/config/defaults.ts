import type { Config } from './types.js';

export const DEFAULT_CONFIG: Config = {
  model: {
    provider: 'ollama',
    name: 'qwen2.5:7b',
    baseUrl: 'http://localhost:11434',
    contextLength: 32768,
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
