import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsCollector, createMetricsCollector } from '../../src/tui/metrics.js';

describe('MetricsCollector', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  describe('factory', () => {
    it('createMetricsCollector returns MetricsCollector instance', () => {
      expect(createMetricsCollector()).toBeInstanceOf(MetricsCollector);
    });
  });

  describe('startTask', () => {
    it('creates metrics entry for task', () => {
      collector.startTask('t1');
      const m = collector.getMetrics('t1');
      expect(m).toBeDefined();
      expect(m!.taskId).toBe('t1');
      expect(m!.llmCalls).toBe(0);
      expect(m!.toolCallCount).toBe(0);
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

  describe('recordToolCall', () => {
    it('increments toolCallCount', () => {
      collector.startTask('t1');
      collector.recordToolCall('t1', 'read');
      collector.recordToolCall('t1', 'edit');
      expect(collector.getMetrics('t1')!.toolCallCount).toBe(2);
    });
  });

  describe('recordStateEntry / recordStateExit', () => {
    it('records timing for a state', async () => {
      collector.startTask('t1');
      collector.recordStateEntry('t1', 'ANALYZE');
      await new Promise((r) => setTimeout(r, 10));
      collector.recordStateExit('t1', 'ANALYZE');
      const timing = collector.getMetrics('t1')!.stateTimings['ANALYZE'];
      expect(timing).toBeGreaterThanOrEqual(5);
    });

    it('ignores exit without matching entry', () => {
      collector.startTask('t1');
      expect(() => collector.recordStateExit('t1', 'LOCATE')).not.toThrow();
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

  describe('getSummary', () => {
    it('returns zeros for empty collector', () => {
      const s = collector.getSummary();
      expect(s.totalTasks).toBe(0);
      expect(s.successRate).toBe(0);
    });

    it('calculates correct successRate', () => {
      collector.startTask('t1');
      collector.finishTask('t1', true);
      collector.startTask('t2');
      collector.finishTask('t2', false);
      expect(collector.getSummary().successRate).toBe(0.5);
    });

    it('calculates avgTokens across tasks', () => {
      collector.startTask('t1');
      collector.recordLLMCall('t1', 400, 0);
      collector.startTask('t2');
      collector.recordLLMCall('t2', 800, 0);
      const s = collector.getSummary();
      expect(s.avgTokens).toBe(150);
    });
  });

  describe('reset', () => {
    it('clears all metrics', () => {
      collector.startTask('t1');
      collector.reset();
      expect(collector.getMetrics('t1')).toBeUndefined();
      expect(collector.getSummary().totalTasks).toBe(0);
    });
  });
});
