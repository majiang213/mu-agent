import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config/loader.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `local-agent-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir: string, cfg: object): void {
  const configDir = join(dir, '.local-agent');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(cfg), 'utf-8');
}

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    const dir = makeTmpDir();
    try {
      const config = loadConfig(dir);
      expect(config.model.provider).toBe('ollama');
      expect(config.model.name).toBe('qwen2.5:7b');
      expect(config.logLevel).toBe('info');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('merges project config over defaults', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, {
        model: { provider: 'ollama', name: 'llama3:8b', baseUrl: 'http://localhost:11434', contextLength: 8192 },
        logLevel: 'debug',
      });
      const config = loadConfig(dir);
      expect(config.model.name).toBe('llama3:8b');
      expect(config.logLevel).toBe('debug');
      expect(config.model.temperature).toBe(0.1);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('throws on invalid model.name', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, {
        model: { provider: 'ollama', name: '', baseUrl: 'http://localhost:11434', contextLength: 4096 },
      });
      expect(() => loadConfig(dir)).toThrow('model.name');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('throws on invalid contextLength', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, {
        model: { provider: 'ollama', name: 'qwen2.5:7b', baseUrl: 'http://localhost:11434', contextLength: -1 },
      });
      expect(() => loadConfig(dir)).toThrow('contextLength');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('throws on invalid logLevel', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, {
        model: { provider: 'ollama', name: 'qwen2.5:7b', baseUrl: 'http://localhost:11434', contextLength: 4096 },
        logLevel: 'verbose',
      });
      expect(() => loadConfig(dir)).toThrow('logLevel');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
