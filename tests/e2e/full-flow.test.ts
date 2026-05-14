import { describe, it, expect, vi } from 'vitest';
import { StateMachineAgent } from '../../src/core/session.js';
import { MetricsCollector } from '../../src/core/metrics.js';
import { State, type Step } from '../../src/core/types.js';

vi.mock('../../src/provider/llm.js', () => ({
  LLMConnector: vi.fn().mockImplementation(() => ({
    generate: vi.fn().mockResolvedValue({ content: '{"summary":"done"}', toolCalls: [] }),
  })),
}));

describe('E2E: Full Agent Flow (mock LLM)', () => {
  it('StateMachineAgent completes full state transition sequence', () => {
    const agent = new StateMachineAgent('qwen2.5:7b');

    expect(agent.getCurrentState()).toBe(State.REASON);

    agent.transitionTo(State.LOCATE);
    expect(agent.getCurrentState()).toBe(State.LOCATE);

    agent.transitionTo(State.MODIFY);
    expect(agent.getCurrentState()).toBe(State.MODIFY);

    agent.transitionTo(State.VERIFY);
    expect(agent.getCurrentState()).toBe(State.VERIFY);

    agent.transitionTo(State.DONE);
    expect(agent.getCurrentState()).toBe(State.DONE);
  });

  it('Step type holds state and focus', () => {
    const step: Step = { state: State.MODIFY, focus: '在 login() 后添加 logout() 方法' };
    expect(step.state).toBe(State.MODIFY);
    expect(step.focus).toContain('logout');
  });

  it('dynamic agenda: multi-step plan from REASON output', () => {
    const steps: Step[] = [
      { state: State.ANALYZE, focus: '理解 auth.ts 结构' },
      { state: State.MODIFY, focus: '添加 logout 方法' },
      { state: State.VERIFY, focus: '运行测试' },
    ];
    expect(steps).toHaveLength(3);
    expect(steps[0]!.state).toBe(State.ANALYZE);
    expect(steps[1]!.focus).toContain('logout');
  });

  it('MetricsCollector tracks a complete task lifecycle', () => {
    const metrics = new MetricsCollector();
    metrics.startTask('e2e-1');
    metrics.recordStateEntry('e2e-1', 'ANALYZE');
    metrics.recordLLMCall('e2e-1', 500, 200);
    metrics.recordToolCall('e2e-1', 'read');
    metrics.recordStateExit('e2e-1', 'ANALYZE');
    metrics.finishTask('e2e-1', true);

    const m = metrics.getMetrics('e2e-1')!;
    expect(m.llmCalls).toBe(1);
    expect(m.toolCallCount).toBe(1);
    expect(m.estimatedTokens).toBeGreaterThan(0);
    expect(m.success).toBe(true);
    expect(m.endTime).toBeDefined();
  });

  it('full pipeline: dynamic steps → state machine → metrics', () => {
    const metrics = new MetricsCollector();
    const agent = new StateMachineAgent('qwen2.5:7b');

    const steps: Step[] = [
      { state: State.ANALYZE, focus: '分析 bug 位置' },
      { state: State.MODIFY, focus: '修复 bug' },
      { state: State.VERIFY, focus: '写测试验证' },
    ];

    const taskId = 'step-0';
    metrics.startTask(taskId);
    metrics.recordStateEntry(taskId, 'ANALYZE');

    agent.transitionTo(State.ANALYZE);
    const prompt = agent.generatePrompt(steps[0]!.focus);
    expect(prompt.toLowerCase()).toContain('coding assistant');

    metrics.recordLLMCall(taskId, prompt.length, 100);
    metrics.recordStateExit(taskId, 'ANALYZE');
    metrics.finishTask(taskId, true);

    const summary = metrics.getSummary();
    expect(summary.totalTasks).toBe(1);
    expect(summary.successRate).toBe(1.0);
  });
});
