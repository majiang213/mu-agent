import { describe, it, expect } from 'vitest';
import { getDefaultConfig, mergeWithDefaults } from '../../src/config/defaults.js';
import type { Config } from '../../src/config/types.js';

describe('config defaults', () => {
  describe('getDefaultConfig', () => {
    it('should return default configuration', () => {
      const config = getDefaultConfig();

      expect(config).toHaveProperty('system');
      expect(config).toHaveProperty('runtime');
      expect(config).toHaveProperty('stateMachine');

      expect(config.system).toHaveProperty('model');
      expect(config.system).toHaveProperty('task');
      expect(config.system).toHaveProperty('hardware');
      expect(config.system).toHaveProperty('logLevel');

      expect(config.runtime).toHaveProperty('currentVramUsage');
      expect(config.runtime).toHaveProperty('currentRamUsage');
      expect(config.runtime).toHaveProperty('pauseNewTasks');
      expect(config.runtime).toHaveProperty('adjustedContextLength');

      expect(config.stateMachine).toHaveProperty('enableStagnationDetector');
      expect(config.stateMachine).toHaveProperty('enableCompaction');
      expect(config.stateMachine).toHaveProperty('compactionThreshold');
    });

    it('should have valid hardware constraints', () => {
      const config = getDefaultConfig();

      expect(config.system.hardware.maxRamBytes).toBeGreaterThan(0);
      expect(config.system.hardware.recommendedContextLength).toBeGreaterThan(0);
      expect(['3B', '7B', '8B', '13B']).toContain(config.system.hardware.recommendedModelSize);
    });
  });

  describe('mergeWithDefaults', () => {
    it('should merge user config with defaults', () => {
      const userConfig: Partial<Config> = {
        system: {
          logLevel: 'debug',
        } as Config['system'],
      };

      const config = mergeWithDefaults(userConfig);

      expect(config.system.logLevel).toBe('debug');
      expect(config.system.model).toBeDefined();
    });

    it('should use defaults for missing values', () => {
      const config = mergeWithDefaults({});

      expect(config.system.logLevel).toBe('info');
      expect(config.stateMachine.enableStagnationDetector).toBe(true);
    });
  });
});
