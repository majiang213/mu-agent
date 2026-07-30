export interface TaskMetrics {
  taskId: string;
  startTime: number;
  endTime?: number;
  llmCalls: number;
  estimatedTokens: number;
  success: boolean;
}

export class MetricsCollector {
  private metrics: Map<string, TaskMetrics> = new Map();

  startTask(taskId: string): void {
    this.metrics.set(taskId, {
      taskId,
      startTime: Date.now(),
      llmCalls: 0,
      estimatedTokens: 0,
      success: false,
    });
  }

  recordLLMCall(taskId: string, promptLen: number, responseLen: number): void {
    const m = this.metrics.get(taskId);
    if (!m) return;
    m.llmCalls += 1;
    m.estimatedTokens += Math.ceil((promptLen + responseLen) / 4);
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
}
