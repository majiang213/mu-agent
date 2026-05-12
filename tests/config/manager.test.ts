import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigManager, initializeConfig } from '../../src/config/manager.js';

describe('ConfigManager', () => {
  beforeEach(() => {
    ConfigManager.getInstance().destroy();
  });

  afterEach(() => {
    ConfigManager.getInstance().destroy();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = ConfigManager.getInstance();
      const instance2 = ConfigManager.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe('initialize', () => {
    it('should initialize with defaults', () => {
      const manager = ConfigManager.getInstance();
      const config = manager.initialize();

      expect(config).toBeDefined();
      expect(config.system).toBeDefined();
      expect(config.runtime).toBeDefined();
    });
  });

  describe('getConfig', () => {
    it('should return current config', () => {
      const manager = ConfigManager.getInstance();
      manager.initialize();

      const config = manager.getConfig();
      expect(config).toBeDefined();
    });
  });

  describe('updateRuntimeConfig', () => {
    it('should update runtime config', () => {
      const manager = ConfigManager.getInstance();
      manager.initialize();

      manager.updateRuntimeConfig({ currentVramUsage: 50 });

      const config = manager.getConfig();
      expect(config.runtime.currentVramUsage).toBe(50);
    });
  });
});

describe('initializeConfig', () => {
  it('should initialize and return config', () => {
    ConfigManager.getInstance().destroy();

    const config = initializeConfig();

    expect(config).toBeDefined();
    expect(config.system).toBeDefined();
  });
});
