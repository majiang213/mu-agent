import { describe, it, expect } from 'vitest';
import { getDefaultConfig, mergeWithDefaults, escalatedTemperature } from '../../src/config/defaults.js';

describe('getDefaultConfig', () => {
  it('returns a valid config with required fields', () => {
    const config = getDefaultConfig();
    expect(config.model.provider).toBe('ollama');
    expect(config.model.name).toBe('');
    expect(config.model.baseUrl).toBe('http://localhost:11434');
  });

  it('returns independent copies each call', () => {
    const a = getDefaultConfig();
    const b = getDefaultConfig();
    a.model.name = 'changed';
    expect(b.model.name).toBe('');
  });
});

describe('mergeWithDefaults', () => {
  it('overrides model fields with user values', () => {
    const config = mergeWithDefaults({
      model: { provider: 'custom', name: 'gpt-4o', baseUrl: 'https://api.example.com/v1' },
    });
    expect(config.model.name).toBe('gpt-4o');
    expect(config.model.provider).toBe('custom');
  });

  it('fills missing model fields from defaults', () => {
    const config = mergeWithDefaults({
      model: { provider: 'ollama', name: 'llama3:8b', baseUrl: 'http://localhost:11434' },
    });
    expect(config.model.temperature).toBe(0.1);
  });

  it('uses default safety when not specified', () => {
    const config = mergeWithDefaults({
      model: { provider: 'ollama', name: 'x', baseUrl: 'http://localhost:11434' },
    });
    expect(config.safety?.enableCheckpoint).toBe(true);
    expect(config.safety?.maxFilesPerTask).toBe(5);
  });
});

describe('escalatedTemperature (round-6, C4 — the one formula)', () => {
  it('ramps by attempt and caps at MAX_TEMPERATURE', () => {
    expect(escalatedTemperature(0)).toBe(0.1);
    expect(escalatedTemperature(1)).toBeCloseTo(0.3);
    expect(escalatedTemperature(2)).toBeCloseTo(0.5);
    expect(escalatedTemperature(5)).toBe(0.5); // capped
  });
});
