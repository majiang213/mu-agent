import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from './types.js';
import { mergeWithDefaults } from './defaults.js';

const GLOBAL_CONFIG_PATH = join(homedir(), '.config', 'local-agent', 'config.json');
const PROJECT_CONFIG_PATH = join('.local-agent', 'config.json');

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
  if (!model.contextLength || typeof model.contextLength !== 'number' || model.contextLength <= 0) {
    throw new Error(`${source}: model.contextLength must be a positive number`);
  }
  if (!['ollama', 'openai', 'custom'].includes(model.provider)) {
    throw new Error(`${source}: model.provider must be one of: ollama, openai, custom`);
  }
  if (cfg.logLevel !== undefined && !['debug', 'info', 'warn', 'error'].includes(cfg.logLevel)) {
    throw new Error(`${source}: logLevel must be one of: debug, info, warn, error`);
  }
}

export function loadConfig(projectRoot?: string): Config {
  const projectConfigPath = projectRoot ? join(projectRoot, '.local-agent', 'config.json') : PROJECT_CONFIG_PATH;

  let globalPartial: Partial<Config> = {};
  let projectPartial: Partial<Config> = {};

  if (existsSync(GLOBAL_CONFIG_PATH)) {
    globalPartial = readJson(GLOBAL_CONFIG_PATH);
  }

  if (existsSync(projectConfigPath)) {
    projectPartial = readJson(projectConfigPath);
  }

  const layered: Partial<import('./types.js').Config> = {
    ...globalPartial,
    ...projectPartial,
    ...(globalPartial.model || projectPartial.model
      ? { model: { ...globalPartial.model, ...projectPartial.model } as import('./types.js').ModelConfig }
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
