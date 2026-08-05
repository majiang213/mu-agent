import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from './types.js';
import { mergeWithDefaults, MU_AGENT_DIR } from './defaults.js';

const GLOBAL_CONFIG_PATH = join(homedir(), '.config', 'mu-agent', 'config.json');
const PROJECT_CONFIG_PATH = join(MU_AGENT_DIR, 'config.json');

/**
 * Absolute paths of the two config files, in precedence order (project
 * first, then global). The ONE place that knows where config lives — the
 * setup wizard reads its defaults through this instead of re-hardcoding
 * (third-pass review, candidate 13).
 */
export function configPaths(cwd: string = process.cwd()): string[] {
  return [join(cwd, PROJECT_CONFIG_PATH), GLOBAL_CONFIG_PATH];
}

export class ConfigNotFoundError extends Error {
  constructor() {
    super('Config not found. Run setup first:\n  mu-agent setup');
    this.name = 'ConfigNotFoundError';
  }
}

function mergeNestedSection<T extends object>(existing: T | undefined, updates: T | undefined): T | undefined {
  if (!existing && !updates) return undefined;
  return { ...existing, ...updates } as T;
}

function readJson(path: string): Partial<Config> {
  const text = readFileSync(path, 'utf-8');
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config file ${path} must be a JSON object`);
  }
  return parsed as Partial<Config>;
}

function validateConfig(cfg: Config, source: string): void {
  const { model } = cfg;
  if (!model) throw new Error(`${source}: "model" field is required`);
  if (!model.name || typeof model.name !== 'string') {
    throw new Error(`${source}: model.name must be a non-empty string`);
  }
  if (!model.baseUrl || typeof model.baseUrl !== 'string') {
    throw new Error(`${source}: model.baseUrl must be a non-empty string`);
  }
  if (!['ollama', 'custom', 'unsloth'].includes(model.provider)) {
    throw new Error(`${source}: model.provider must be one of: ollama, custom, unsloth`);
  }
  const ext = cfg.extensions;
  if (ext) {
    if (ext.enabled !== undefined && typeof ext.enabled !== 'boolean') {
      throw new Error(`${source}: extensions.enabled must be a boolean`);
    }
    if (ext.paths !== undefined && (!Array.isArray(ext.paths) || ext.paths.some((p) => typeof p !== 'string'))) {
      throw new Error(`${source}: extensions.paths must be an array of strings`);
    }
    if (
      ext.toolStates !== undefined &&
      (!Array.isArray(ext.toolStates) || ext.toolStates.some((s) => typeof s !== 'string'))
    ) {
      throw new Error(`${source}: extensions.toolStates must be an array of strings`);
    }
  }
}

export function loadConfig(projectRoot?: string): Config {
  const projectConfigPath = projectRoot ? join(projectRoot, MU_AGENT_DIR, 'config.json') : PROJECT_CONFIG_PATH;

  const globalExists = existsSync(GLOBAL_CONFIG_PATH);
  const projectExists = existsSync(projectConfigPath);

  if (!globalExists && !projectExists) {
    throw new ConfigNotFoundError();
  }

  let globalPartial: Partial<Config> = {};
  let projectPartial: Partial<Config> = {};

  if (globalExists) {
    globalPartial = readJson(GLOBAL_CONFIG_PATH);
  }

  if (projectExists) {
    projectPartial = readJson(projectConfigPath);
  }

  const mergedModel = mergeNestedSection(globalPartial.model, projectPartial.model);
  const mergedSafety = mergeNestedSection(globalPartial.safety, projectPartial.safety);
  const mergedExtensions = mergeNestedSection(globalPartial.extensions, projectPartial.extensions);

  const layered: Partial<Config> = {
    ...globalPartial,
    ...projectPartial,
    ...(mergedModel ? { model: mergedModel as Config['model'] } : {}),
    ...(mergedSafety ? { safety: mergedSafety } : {}),
    ...(mergedExtensions ? { extensions: mergedExtensions } : {}),
  };

  const merged = mergeWithDefaults(layered);
  validateConfig(merged, 'config');
  return merged;
}

export function saveConfig(updates: Partial<Config>, projectRoot?: string): void {
  const projectConfigPath = projectRoot ? join(projectRoot, MU_AGENT_DIR, 'config.json') : PROJECT_CONFIG_PATH;

  const existing: Partial<Config> = existsSync(projectConfigPath) ? readJson(projectConfigPath) : {};

  const mergedModel = mergeNestedSection(existing.model, updates.model);
  const mergedSafety = mergeNestedSection(existing.safety, updates.safety);
  const mergedExtensions = mergeNestedSection(existing.extensions, updates.extensions);

  const merged: Partial<Config> = {
    ...existing,
    ...updates,
    ...(mergedModel ? { model: mergedModel as Config['model'] } : {}),
    ...(mergedSafety ? { safety: mergedSafety } : {}),
    ...(mergedExtensions ? { extensions: mergedExtensions } : {}),
  };

  const dir = dirname(projectConfigPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Validate the would-be persisted config (merged over defaults) before
  // writing — load and save must never disagree about what a valid file is.
  validateConfig(mergeWithDefaults(merged), 'config');

  writeFileSync(projectConfigPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}
