import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsCollector } from '../../src/tui/metrics.js';

describe('MetricsCollector', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  describe('startTask', () => {
    it('creates metrics entry for task', () => {
      collector.startTask('t1');
      const m = collector.getMetrics('t1');
      expect(m).toBeDefined();
      expect(m!.taskId).toBe('t1');
      expect(m!.llmCalls).toBe(0);
    });

    it('startTime is set to a recent timestamp', () => {
      const before = Date.now();
      collector.startTask('t1');
      const after = Date.now();
      const m = collector.getMetrics('t1')!;
      expect(m.startTime).toBeGreaterThanOrEqual(before);
      expect(m.startTime).toBeLessThanOrEqual(after);
    });
  });

  describe('recordLLMCall', () => {
    it('increments llmCalls counter', () => {
      collector.startTask('t1');
      collector.recordLLMCall('t1', 100, 50);
      collector.recordLLMCall('t1', 200, 100);
      expect(collector.getMetrics('t1')!.llmCalls).toBe(2);
    });

    it('accumulates estimated tokens', () => {
      collector.startTask('t1');
      collector.recordLLMCall('t1', 400, 400);
      expect(collector.getMetrics('t1')!.estimatedTokens).toBe(200);
    });
  });

  describe('finishTask', () => {
    it('sets endTime and success', () => {
      collector.startTask('t1');
      collector.finishTask('t1', true);
      const m = collector.getMetrics('t1')!;
      expect(m.endTime).toBeDefined();
      expect(m.success).toBe(true);
    });
  });
});
