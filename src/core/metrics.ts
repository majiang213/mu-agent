export interface TaskMetrics {
  taskId: string;
  startTime: number;
  endTime?: number;
  stateTimings: Record<string, number>;
  llmCalls: number;
  estimatedTokens: number;
  toolCallCount: number;
  success: boolean;
}

export interface MetricsSummary {
  totalTasks: number;
  successRate: number;
  avgTokens: number;
  avgDurationMs: number;
}

export class MetricsCollector {
  private metrics: Map<string, TaskMetrics> = new Map();
  private stateEntryTimes: Map<string, number> = new Map();

  startTask(taskId: string): void {
    this.metrics.set(taskId, {
      taskId,
      startTime: Date.now(),
      stateTimings: {},
      llmCalls: 0,
      estimatedTokens: 0,
      toolCallCount: 0,
      success: false,
    });
  }

  recordStateEntry(taskId: string, state: string): void {
    this.stateEntryTimes.set(`${taskId}:${state}`, Date.now());
  }

  recordStateExit(taskId: string, state: string): void {
    const key = `${taskId}:${state}`;
    const entry = this.stateEntryTimes.get(key);
    if (entry === undefined) return;
    const m = this.metrics.get(taskId);
    if (!m) return;
    m.stateTimings[state] = (m.stateTimings[state] ?? 0) + (Date.now() - entry);
    this.stateEntryTimes.delete(key);
  }

  recordLLMCall(taskId: string, promptLen: number, responseLen: number): void {
    const m = this.metrics.get(taskId);
    if (!m) return;
    m.llmCalls += 1;
    m.estimatedTokens += Math.ceil((promptLen + responseLen) / 4);
  }

  recordToolCall(taskId: string, _toolName: string): void {
    const m = this.metrics.get(taskId);
    if (!m) return;
    m.toolCallCount += 1;
  }

  finishTask(taskId: string, success: boolean): void {
    const m = this.metrics.get(taskId);
    if (!m) return;
    m.endTime = Date.now();
    m.success = success;
  }

  getMetrics(taskId: string): TaskMetrics | undefined {
    return this.metrics.get(taskId);
  }

  getSummary(): MetricsSummary {
    const all = Array.from(this.metrics.values());
    if (all.length === 0) {
      return { totalTasks: 0, successRate: 0, avgTokens: 0, avgDurationMs: 0 };
    }
    const succeeded = all.filter((m) => m.success).length;
    const totalTokens = all.reduce((s, m) => s + m.estimatedTokens, 0);
    const totalDuration = all
      .filter((m) => m.endTime !== undefined)
      .reduce((s, m) => s + (m.endTime! - m.startTime), 0);
    const finishedCount = all.filter((m) => m.endTime !== undefined).length;
    return {
      totalTasks: all.length,
      successRate: succeeded / all.length,
      avgTokens: totalTokens / all.length,
      avgDurationMs: finishedCount > 0 ? totalDuration / finishedCount : 0,
    };
  }

  reset(): void {
    this.metrics.clear();
    this.stateEntryTimes.clear();
  }
}

export function createMetricsCollector(): MetricsCollector {
  return new MetricsCollector();
}
