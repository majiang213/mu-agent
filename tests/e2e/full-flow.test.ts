import { describe, it, expect, vi } from 'vitest';
import { StateMachineAgent } from '../../src/core/session.js';
import { Planner } from '../../src/core/decomposer.js';
import { MetricsCollector } from '../../src/core/metrics.js';
import { State } from '../../src/core/types.js';

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

  it('Planner decomposes sequential prompt', async () => {
    const decomposer = new Planner();
    const result = await decomposer.decompose('先修复登录bug然后写测试');
    expect(result.tasks.length).toBeGreaterThanOrEqual(2);
    expect(result.tasks[0]!.description).toContain('修复登录bug');
  });

  it('Planner falls back to single task for simple prompt', async () => {
    const decomposer = new Planner();
    const result = await decomposer.decompose('帮我看看这个项目');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.description).toBe('帮我看看这个项目');
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

  it('full pipeline: decompose → state machine → metrics', async () => {
    const metrics = new MetricsCollector();
    const decomposer = new Planner();
    const agent = new StateMachineAgent('qwen2.5:7b');

    const result = await decomposer.decompose('先修复bug然后写测试');
    expect(result.tasks.length).toBeGreaterThanOrEqual(2);

    const taskId = result.tasks[0]!.id;
    metrics.startTask(taskId);
    metrics.recordStateEntry(taskId, 'ANALYZE');

    const prompt = agent.generatePrompt(result.tasks[0]!.description);
    expect(prompt.toLowerCase()).toContain('coding assistant');

    metrics.recordLLMCall(taskId, prompt.length, 100);
    metrics.recordStateExit(taskId, 'ANALYZE');
    metrics.finishTask(taskId, true);

    const summary = metrics.getSummary();
    expect(summary.totalTasks).toBe(1);
    expect(summary.successRate).toBe(1.0);
  });
});
