import deepmerge from 'deepmerge';
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
  safety: {
    enableCheckpoint: true,
    maxLinesPerEdit: 50,
    maxFilesPerTask: 5,
  },
};

export function getDefaultConfig(): Config {
  return structuredClone(DEFAULT_CONFIG);
}

export function mergeWithDefaults(partial: Partial<Config>): Config {
  return deepmerge(getDefaultConfig(), partial as Config) as Config;
}
