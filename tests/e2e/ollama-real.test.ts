import { describe, it, expect, beforeAll } from 'vitest';
import { LLMConnector } from '../../src/provider/llm.js';
import { LLMService } from '../../src/provider/llm-service.js';
import { StateMachineAgent } from '../../src/core/session.js';
import { TaskDecomposer } from '../../src/core/decomposer.js';
import { MetricsCollector } from '../../src/core/metrics.js';
import { State } from '../../src/core/types.js';

const MODEL = 'qwen3.5:9b';
const BASE_URL = 'http://localhost:11434';
const PROVIDER = 'ollama';

async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

describe('Real Ollama Integration', () => {
  beforeAll(async () => {
    const running = await isOllamaRunning();
    if (!running) {
      console.warn('Ollama not running — skipping real LLM tests');
    }
  });

  it('LLMConnector: 直接调用 Ollama 返回非空内容', async () => {
    const running = await isOllamaRunning();
    if (!running) return;

    const connector = new LLMConnector(PROVIDER, MODEL, BASE_URL);
    const result = await connector.generate(
      'You are a helpful assistant. Reply in one short sentence.',
      'Say hello in Chinese.',
    );

    console.log('[LLMConnector] response:', result.content.slice(0, 100));
    expect(typeof result.content).toBe('string');
    expect(result.content.length).toBeGreaterThan(0);
  }, 30000);

  it('LLMService: 在 ANALYZE 状态下生成分析响应', async () => {
    const running = await isOllamaRunning();
    if (!running) return;

    const service = new LLMService(PROVIDER, MODEL, BASE_URL);
    const agent = new StateMachineAgent(MODEL);
    const context = agent.createContext('修复 src/auth.ts 中的登录 bug');

    const result = await service.generate(context, '修复 src/auth.ts 中的登录 bug');

    console.log('[LLMService ANALYZE] response:', result.content.slice(0, 200));
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.toolCalls).toBeDefined();
  }, 30000);

  it('TaskDecomposer + LLMService: 分解任务后对第一个子任务调用 LLM', async () => {
    const running = await isOllamaRunning();
    if (!running) return;

    const decomposer = new TaskDecomposer();
    const service = new LLMService(PROVIDER, MODEL, BASE_URL);
    const agent = new StateMachineAgent(MODEL);

    const decomposed = decomposer.decompose('先修复登录bug然后写测试');
    expect(decomposed.tasks.length).toBeGreaterThanOrEqual(2);

    const firstTask = decomposed.tasks[0]!;
    const context = agent.createContext(firstTask.description);
    const result = await service.generate(context, firstTask.description);

    console.log(`[Decompose+LLM] task="${firstTask.description}" level=${decomposed.level}`);
    console.log('[Decompose+LLM] response:', result.content.slice(0, 200));
    expect(result.content.length).toBeGreaterThan(0);
  }, 30000);

  it('MetricsCollector: 追踪真实 LLM 调用的 token 和耗时', async () => {
    const running = await isOllamaRunning();
    if (!running) return;

    const metrics = new MetricsCollector();
    const connector = new LLMConnector(PROVIDER, MODEL, BASE_URL);

    metrics.startTask('real-1');
    metrics.recordStateEntry('real-1', State.ANALYZE);

    const prompt = 'You are a coding assistant. Reply in one sentence.';
    const userMsg = 'What is a function?';
    const result = await connector.generate(prompt, userMsg);

    metrics.recordLLMCall('real-1', prompt.length + userMsg.length, result.content.length);
    metrics.recordStateExit('real-1', State.ANALYZE);
    metrics.finishTask('real-1', true);

    const m = metrics.getMetrics('real-1')!;
    console.log(`[Metrics] tokens≈${m.estimatedTokens}, duration≈${m.endTime! - m.startTime}ms`);
    console.log('[Metrics] ANALYZE timing:', m.stateTimings['ANALYZE']);

    expect(m.llmCalls).toBe(1);
    expect(m.estimatedTokens).toBeGreaterThan(0);
    expect(m.stateTimings['ANALYZE']).toBeGreaterThan(0);
    expect(m.success).toBe(true);
  }, 30000);

  it('完整流程: 分解 → 状态机 → LLM → Metrics 汇总', async () => {
    const running = await isOllamaRunning();
    if (!running) return;

    const decomposer = new TaskDecomposer();
    const metrics = new MetricsCollector();
    const connector = new LLMConnector(PROVIDER, MODEL, BASE_URL);
    const agent = new StateMachineAgent(MODEL);

    const { tasks, level } = decomposer.decompose('先修复登录bug然后写单元测试');
    console.log(`[E2E] decomposed into ${tasks.length} tasks at level ${level}`);

    for (const task of tasks) {
      metrics.startTask(task.id);
      metrics.recordStateEntry(task.id, State.ANALYZE);

      const systemPrompt = agent.generatePrompt(task.description);
      const result = await connector.generate(systemPrompt, task.description);

      metrics.recordLLMCall(task.id, systemPrompt.length, result.content.length);
      metrics.recordStateExit(task.id, State.ANALYZE);
      metrics.finishTask(task.id, result.content.length > 0);

      console.log(`[E2E] task="${task.description}" → ${result.content.slice(0, 80)}...`);
    }

    const summary = metrics.getSummary();
    console.log(`[E2E] summary: tasks=${summary.totalTasks} successRate=${summary.successRate} avgTokens≈${Math.round(summary.avgTokens)}`);

    expect(summary.totalTasks).toBe(tasks.length);
    expect(summary.successRate).toBe(1.0);
    expect(summary.avgTokens).toBeGreaterThan(0);
  }, 60000);
});
