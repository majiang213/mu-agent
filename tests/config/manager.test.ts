import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, ConfigNotFoundError } from '../../src/config/loader.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `mu-agent-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir: string, cfg: object): void {
  const configDir = join(dir, '.mu-agent');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(cfg), 'utf-8');
}

describe('loadConfig', () => {
  describe('ConfigNotFoundError', () => {
    it('throws ConfigNotFoundError when no config file exists', () => {
      const dir = makeTmpDir();
      try {
        expect(() => loadConfig(dir)).toThrow(ConfigNotFoundError);
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    it('error message mentions setup command', () => {
      const dir = makeTmpDir();
      try {
        expect(() => loadConfig(dir)).toThrow('setup');
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    it('ConfigNotFoundError has correct name', () => {
      const dir = makeTmpDir();
      try {
        loadConfig(dir);
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigNotFoundError);
        expect((e as ConfigNotFoundError).name).toBe('ConfigNotFoundError');
        return;
      } finally {
        rmSync(dir, { recursive: true });
      }
      throw new Error('expected to throw');
    });
  });

  describe('valid config', () => {
    it('loads project config when file exists', () => {
      const dir = makeTmpDir();
      try {
        writeConfig(dir, {
          model: { provider: 'ollama', name: 'llama3:8b', baseUrl: 'http://localhost:11434' },
        });
        const config = loadConfig(dir);
        expect(config.model.name).toBe('llama3:8b');
        expect(config.model.provider).toBe('ollama');
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    it('merges project config over defaults', () => {
      const dir = makeTmpDir();
      try {
        writeConfig(dir, {
          model: { provider: 'ollama', name: 'llama3:8b', baseUrl: 'http://localhost:11434' },
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

    it('fills missing model fields from defaults', () => {
      const dir = makeTmpDir();
      try {
        writeConfig(dir, {
          model: { provider: 'ollama', name: 'llama3:8b', baseUrl: 'http://localhost:11434' },
        });
        const config = loadConfig(dir);
        expect(config.model.temperature).toBe(0.1);
        expect(config.safety?.enableCheckpoint).toBe(true);
      } finally {
        rmSync(dir, { recursive: true });
      }
    });
  });

  describe('validation errors', () => {
    it('throws on empty model.name', () => {
      const dir = makeTmpDir();
      try {
        writeConfig(dir, { model: { provider: 'ollama', name: '', baseUrl: 'http://localhost:11434' } });
        expect(() => loadConfig(dir)).toThrow('model.name');
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    it('throws on invalid logLevel', () => {
      const dir = makeTmpDir();
      try {
        writeConfig(dir, {
          model: { provider: 'ollama', name: 'qwen2.5:7b', baseUrl: 'http://localhost:11434' },
          logLevel: 'verbose',
        });
        expect(() => loadConfig(dir)).toThrow('logLevel');
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    it('throws on invalid provider', () => {
      const dir = makeTmpDir();
      try {
        writeConfig(dir, {
          model: { provider: 'openai', name: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
        });
        expect(() => loadConfig(dir)).toThrow('provider');
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    it('throws on empty baseUrl', () => {
      const dir = makeTmpDir();
      try {
        writeConfig(dir, { model: { provider: 'ollama', name: 'qwen2.5:7b', baseUrl: '' } });
        expect(() => loadConfig(dir)).toThrow('baseUrl');
      } finally {
        rmSync(dir, { recursive: true });
      }
    });
  });
});
