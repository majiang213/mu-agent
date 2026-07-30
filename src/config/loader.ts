import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from './types.js';
import { mergeWithDefaults, MU_AGENT_DIR } from './defaults.js';

const GLOBAL_CONFIG_PATH = join(homedir(), '.config', 'mu-agent', 'config.json');
const PROJECT_CONFIG_PATH = join(MU_AGENT_DIR, 'config.json');

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

  const layered: Partial<Config> = {
    ...globalPartial,
    ...projectPartial,
    ...(mergedModel ? { model: mergedModel as Config['model'] } : {}),
    ...(mergedSafety ? { safety: mergedSafety } : {}),
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

  const merged: Partial<Config> = {
    ...existing,
    ...updates,
    ...(mergedModel ? { model: mergedModel as Config['model'] } : {}),
    ...(mergedSafety ? { safety: mergedSafety } : {}),
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
