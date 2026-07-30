import deepmerge from 'deepmerge';
import type { Config } from './types.js';

/** The project's local data directory (graph db, memory db, sessions, checkpoints). */
export const MU_AGENT_DIR = '.mu-agent';

export const DEFAULT_TEMPERATURE = 0.1;
export const MAX_TEMPERATURE = 0.5;
export const RETRY_TEMPERATURE_STEP = 0.2;
export const DEFAULT_CONTEXT_RATIO = 0.75;
export const DEFAULT_SAMPLING_TEMPERATURE = 0.7;

/**
 * Default per-task edit budget — the ONE file-budget default (third-pass
 * review, candidate 14). The tier table in ModelParams was dead code: it
 * never fired because this default always won, and no prompt ever showed
 * it to the model. Safety config is the single source now.
 */
export const DEFAULT_MAX_FILES_PER_TASK = 5;

export const DEFAULT_CONFIG: Config = {
  model: {
    provider: 'ollama',
    name: '',
    baseUrl: 'http://localhost:11434',
    temperature: 0.1,
  },
  safety: {
    enableCheckpoint: true,
    maxFilesPerTask: DEFAULT_MAX_FILES_PER_TASK,
  },
};

export function getDefaultConfig(): Config {
  return structuredClone(DEFAULT_CONFIG);
}

export function mergeWithDefaults(partial: Partial<Config>): Config {
  return deepmerge(getDefaultConfig(), partial as Config) as Config;
}
