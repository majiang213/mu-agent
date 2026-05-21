import { describe, it, expect } from 'vitest';
import { getDefaultConfig, mergeWithDefaults } from '../../src/config/defaults.js';

describe('getDefaultConfig', () => {
  it('returns a valid config with required fields', () => {
    const config = getDefaultConfig();
    expect(config.model.provider).toBe('ollama');
    expect(config.model.name).toBe('qwen2.5:7b');
    expect(config.model.baseUrl).toBe('http://localhost:11434');
    expect(config.model.contextLength).toBeGreaterThan(0);
    expect(config.logLevel).toBe('info');
  });

  it('returns independent copies each call', () => {
    const a = getDefaultConfig();
    const b = getDefaultConfig();
    a.model.name = 'changed';
    expect(b.model.name).toBe('qwen2.5:7b');
  });
});

describe('mergeWithDefaults', () => {
  it('overrides model fields with user values', () => {
    const config = mergeWithDefaults({
      model: { provider: 'openai', name: 'gpt-4o', baseUrl: 'https://api.openai.com', contextLength: 128000 },
    });
    expect(config.model.name).toBe('gpt-4o');
    expect(config.model.provider).toBe('openai');
    expect(config.model.contextLength).toBe(128000);
  });

  it('fills missing model fields from defaults', () => {
    const config = mergeWithDefaults({
      model: { provider: 'ollama', name: 'llama3:8b', baseUrl: 'http://localhost:11434', contextLength: 8192 },
    });
    expect(config.model.temperature).toBe(0.1);
  });

  it('overrides logLevel', () => {
    const config = mergeWithDefaults({
      model: { provider: 'ollama', name: 'x', baseUrl: 'http://localhost:11434', contextLength: 4096 },
      logLevel: 'debug',
    });
    expect(config.logLevel).toBe('debug');
  });

  it('uses default safety when not specified', () => {
    const config = mergeWithDefaults({
      model: { provider: 'ollama', name: 'x', baseUrl: 'http://localhost:11434', contextLength: 4096 },
    });
    expect(config.safety?.enableCheckpoint).toBe(true);
    expect(config.safety?.maxFilesPerTask).toBe(5);
  });
});
