import { describe, it, expect } from 'vitest';
import { getSysInfo, getVramUsage, calculateHardwareConstraints } from '../../src/sysinfo/collector.js';

describe('sysinfo collector', () => {
  describe('getSysInfo', () => {
    it('should return system information', () => {
      const info = getSysInfo();

      expect(info).toHaveProperty('platform');
      expect(info).toHaveProperty('arch');
      expect(info).toHaveProperty('totalMemory');
      expect(info).toHaveProperty('freeMemory');
      expect(info).toHaveProperty('cpuCount');
      expect(info).toHaveProperty('cpuModel');
      expect(info).toHaveProperty('timestamp');

      expect(typeof info.platform).toBe('string');
      expect(typeof info.totalMemory).toBe('number');
      expect(info.totalMemory).toBeGreaterThan(0);
      expect(typeof info.cpuCount).toBe('number');
      expect(info.cpuCount).toBeGreaterThan(0);
    });
  });

  describe('getVramUsage', () => {
    it('should return VRAM usage or undefined', () => {
      const usage = getVramUsage();

      if (usage !== undefined) {
        expect(usage).toHaveProperty('total');
        expect(usage).toHaveProperty('used');
        expect(usage).toHaveProperty('free');
        expect(usage).toHaveProperty('percentage');
        expect(usage).toHaveProperty('timestamp');

        expect(typeof usage.total).toBe('number');
        expect(typeof usage.percentage).toBe('number');
        expect(usage.percentage).toBeGreaterThanOrEqual(0);
        expect(usage.percentage).toBeLessThanOrEqual(100);
      }
    });
  });

  describe('calculateHardwareConstraints', () => {
    it('should calculate constraints based on system info', () => {
      const sysInfo = getSysInfo();
      const constraints = calculateHardwareConstraints(sysInfo);

      expect(constraints).toHaveProperty('maxVramBytes');
      expect(constraints).toHaveProperty('maxRamBytes');
      expect(constraints).toHaveProperty('recommendedContextLength');
      expect(constraints).toHaveProperty('recommendedModelSize');

      expect(typeof constraints.maxRamBytes).toBe('number');
      expect(typeof constraints.recommendedContextLength).toBe('number');
      expect(typeof constraints.recommendedModelSize).toBe('string');

      expect(constraints.maxRamBytes).toBeGreaterThan(0);
      expect(constraints.recommendedContextLength).toBeGreaterThan(0);
    });
  });
});
