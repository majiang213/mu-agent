import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from './types.js';
import { mergeWithDefaults } from './defaults.js';

const GLOBAL_CONFIG_PATH = join(homedir(), '.config', 'mu-agent', 'config.json');
const PROJECT_CONFIG_PATH = join('.mu-agent', 'config.json');

export class ConfigNotFoundError extends Error {
  constructor() {
    super('未找到配置文件。请先运行 setup 完成初始化：\n  npx tsx src/cli.ts setup');
    this.name = 'ConfigNotFoundError';
  }
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
  if (!['ollama', 'custom'].includes(model.provider)) {
    throw new Error(`${source}: model.provider must be one of: ollama, custom`);
  }
  if (cfg.logLevel !== undefined && !['debug', 'info', 'warn', 'error'].includes(cfg.logLevel)) {
    throw new Error(`${source}: logLevel must be one of: debug, info, warn, error`);
  }
}

export function loadConfig(projectRoot?: string): Config {
  const projectConfigPath = projectRoot ? join(projectRoot, '.mu-agent', 'config.json') : PROJECT_CONFIG_PATH;

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

  const layered: Partial<Config> = {
    ...globalPartial,
    ...projectPartial,
    ...(globalPartial.model || projectPartial.model
      ? { model: { ...globalPartial.model, ...projectPartial.model } as Config['model'] }
      : {}),
    ...(globalPartial.toolOutput || projectPartial.toolOutput
      ? { toolOutput: { ...globalPartial.toolOutput, ...projectPartial.toolOutput } }
      : {}),
    ...(globalPartial.safety || projectPartial.safety
      ? { safety: { ...globalPartial.safety, ...projectPartial.safety } }
      : {}),
  };

  const merged = mergeWithDefaults(layered);
  validateConfig(merged, 'config');
  return merged;
}

export function saveConfig(updates: Partial<Config>, projectRoot?: string): void {
  const projectConfigPath = projectRoot ? join(projectRoot, '.mu-agent', 'config.json') : PROJECT_CONFIG_PATH;

  const existing: Partial<Config> = existsSync(projectConfigPath) ? readJson(projectConfigPath) : {};

  const merged: Partial<Config> = {
    ...existing,
    ...updates,
    ...(existing.model || updates.model ? { model: { ...existing.model, ...updates.model } as Config['model'] } : {}),
    ...(existing.toolOutput || updates.toolOutput
      ? { toolOutput: { ...existing.toolOutput, ...updates.toolOutput } }
      : {}),
    ...(existing.safety || updates.safety ? { safety: { ...existing.safety, ...updates.safety } } : {}),
  };

  const dir = dirname(projectConfigPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(projectConfigPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}
