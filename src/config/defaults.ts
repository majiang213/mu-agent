import deepmerge from 'deepmerge';
import type { Config } from './types.js';
import { defaultBaseUrl } from '../provider/providers.js';

/** The project's local data directory (graph db, memory db, sessions, checkpoints). */
export const MU_AGENT_DIR = '.mu-agent';

export const DEFAULT_TEMPERATURE = 0.1;
export const MAX_TEMPERATURE = 0.5;
export const RETRY_TEMPERATURE_STEP = 0.2;

/**
 * Retry temperature escalation — the ONE formula (architecture review
 * 2026-08-05, candidate 4). runStepAgent writes the result onto its per-step
 * RunConfig spread, so the shared config is never mutated (C14).
 */
export function escalatedTemperature(attempt: number): number {
  return Math.min(DEFAULT_TEMPERATURE + attempt * RETRY_TEMPERATURE_STEP, MAX_TEMPERATURE);
}
export const DEFAULT_CONTEXT_RATIO = 0.75;
export const DEFAULT_SAMPLING_TEMPERATURE = 0.7;

/**
 * Default per-task edit budget — the ONE file-budget default (third-pass
 * review, candidate 14). The tier table in ModelParams was dead code: it
 * never fired because this default always won, and no prompt ever showed
 * it to the model. Safety config is the single source now.
 */
export const DEFAULT_MAX_FILES_PER_TASK = 5;

/**
 * States extension-registered tools may enter by default (Gap 85-A).
 * REASON/MODIFY/VERIFY are NEVER eligible — EXTENSION_TOOL_BLACKLIST enforces
 * that even when the user lists them in config.
 */
export const DEFAULT_EXTENSION_TOOL_STATES = ['RESEARCH', 'DIAGNOSE', 'REVIEW', 'ANSWER'] as const;

/** Hard exclusion for extension tools — small-model discipline + checkpoint integrity. */
export const EXTENSION_TOOL_BLACKLIST = ['REASON', 'MODIFY', 'VERIFY'] as const;

export const DEFAULT_CONFIG: Config = {
  model: {
    provider: 'ollama',
    name: '',
    // From the one provider table (round-7, C6) — no second hardcoding.
    baseUrl: defaultBaseUrl('ollama'),
    temperature: DEFAULT_TEMPERATURE,
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
