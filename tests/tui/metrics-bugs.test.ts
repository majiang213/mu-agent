import { describe, it, expect } from 'vitest';
import { MetricsCollector } from '../../src/tui/metrics.js';

// Bug 19 (tui/metrics.ts:93): getSummary() returns NaN for avgDurationMs when finishedCount=0.

describe('Bug 19: getSummary() avgDurationMs is NaN when no tasks finished', () => {
  it('returns 0 for avgDurationMs when no tasks have endTime set', () => {
    const collector = new MetricsCollector();

    // Start a task but don't finish it (no endTime).
    collector.startTask('task-1');
    collector.recordLLMCall('task-1', 100, 50);
    collector.recordToolCall('task-1', 'read');

    const summary = collector.getSummary();

    // Bug 19 (metrics.ts:93): The reduce accumulates totalDuration and finishedCount.
    // If finishedCount=0, the return is totalDuration / finishedCount = 0 / 0 = NaN.
    // After fix, should return 0 when finishedCount is 0.
    expect(summary.avgDurationMs).not.toBeNaN();
    expect(summary.avgDurationMs).toBe(0);
  });

  it('calculates avgDurationMs correctly when tasks are finished', () => {
    const collector = new MetricsCollector();

    collector.startTask('task-1');
    collector.finishTask('task-1', true);

    collector.startTask('task-2');
    collector.finishTask('task-2', false);

    const summary = collector.getSummary();

    expect(summary.totalTasks).toBe(2);
    expect(summary.avgDurationMs).not.toBeNaN();
    expect(summary.avgDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns all zeros for empty metrics', () => {
    const collector = new MetricsCollector();
    const summary = collector.getSummary();

    expect(summary.totalTasks).toBe(0);
    expect(summary.successRate).toBe(0);
    expect(summary.avgTokens).toBe(0);
    expect(summary.avgDurationMs).toBe(0);
  });
});
