import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VramWatcher } from '../../src/sysinfo/watcher.js';

describe('VramWatcher', () => {
  let watcher: VramWatcher;

  beforeEach(() => {
    watcher = new VramWatcher({
      intervalMs: 100,
      warningThreshold: 80,
      criticalThreshold: 95,
    });
  });

  afterEach(() => {
    watcher.stop();
  });

  describe('start/stop', () => {
    it('should start and stop watching', () => {
      expect(watcher.isRunning()).toBe(false);

      watcher.start();
      expect(watcher.isRunning()).toBe(true);

      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it('should not start twice', () => {
      watcher.start();
      watcher.start();
      expect(watcher.isRunning()).toBe(true);
    });
  });

  describe('getLastUsage', () => {
    it('should return null before first check', () => {
      expect(watcher.getLastUsage()).toBeNull();
    });

    it('should return usage after starting', async () => {
      watcher.start();

      await new Promise((resolve) => setTimeout(resolve, 150));

      const usage = watcher.getLastUsage();
      expect(usage).not.toBeNull();
    });
  });

  describe('events', () => {
    it('should emit usage events', async () => {
      const usageEvents: unknown[] = [];
      watcher.on('usage', (usage) => usageEvents.push(usage));

      watcher.start();
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(usageEvents.length).toBeGreaterThan(0);
    });
  });
});
