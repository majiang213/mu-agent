import { describe, it, expect, beforeAll } from 'vitest';
import { LLMConnector } from '../../src/provider/llm.js';
import { LLMService } from '../../src/provider/llm-service.js';
import { StateMachineAgent } from '../../src/core/session.js';
import { MetricsCollector } from '../../src/core/metrics.js';
import { State, type Step } from '../../src/core/types.js';
import { loadConfig } from '../../src/config/loader.js';

const config = loadConfig();
const MODEL = config.model.name;
const BASE_URL = config.model.baseUrl;
const PROVIDER = config.model.provider;

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
      throw new Error(
        `Ollama is not running at ${BASE_URL}. Start Ollama and ensure model "${MODEL}" is available before running these tests.`,
      );
    }
  });

  it('LLMConnector: 直接调用 Ollama 返回非空内容', async () => {
    const connector = new LLMConnector(PROVIDER, MODEL, BASE_URL);
    const result = await connector.generate('You are a helpful assistant.', '你好');
    console.log('[LLMConnector] response:', result.content);
    expect(result.content.length).toBeGreaterThan(0);
  }, 30000);

  it('LLMService: 在 REASON 状态下生成分析响应', async () => {
    const service = new LLMService(PROVIDER, MODEL, BASE_URL);
    const agent = new StateMachineAgent(MODEL);
    const context = agent.createContext('帮我给 foo.ts 加一个 hello 函数');
    const result = await service.generate(context, '帮我给 foo.ts 加一个 hello 函数');

    console.log('[LLMService REASON] response:', result.content.slice(0, 200));
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.toolCalls).toBeDefined();
  }, 30000);

  it('动态步骤 + LLMService: 对第一个 Step 调用 LLM', async () => {
    const steps: Step[] = [
      { state: State.ANALYZE, focus: '分析登录 bug 的位置' },
      { state: State.MODIFY, focus: '修复 bug' },
      { state: State.VERIFY, focus: '写测试验证' },
    ];

    const service = new LLMService(PROVIDER, MODEL, BASE_URL);
    const agent = new StateMachineAgent(MODEL);
    agent.transitionTo(steps[0]!.state);

    const context = agent.createContext(steps[0]!.focus);
    const result = await service.generate(context, steps[0]!.focus);

    console.log(`[Dynamic+LLM] focus="${steps[0]!.focus}"`);
    console.log('[Dynamic+LLM] response:', result.content.slice(0, 200));
    expect(result.content.length).toBeGreaterThan(0);
  }, 30000);

  it('MetricsCollector: 追踪真实 LLM 调用的 token 和耗时', async () => {
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

  it('完整流程: 动态步骤 → 状态机 → LLM → Metrics 汇总', async () => {
    const steps: Step[] = [
      { state: State.ANALYZE, focus: '分析登录 bug 位置' },
      { state: State.MODIFY, focus: '修复 bug' },
    ];

    const metrics = new MetricsCollector();
    const connector = new LLMConnector(PROVIDER, MODEL, BASE_URL);
    const agent = new StateMachineAgent(MODEL);

    console.log(`[E2E] executing ${steps.length} dynamic steps`);

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const taskId = `step-${i}`;
      agent.transitionTo(step.state);
      metrics.startTask(taskId);
      metrics.recordStateEntry(taskId, step.state);

      const systemPrompt = agent.generatePrompt(step.focus);
      const result = await connector.generate(systemPrompt, step.focus);

      metrics.recordLLMCall(taskId, systemPrompt.length, result.content.length);
      metrics.recordStateExit(taskId, step.state);
      metrics.finishTask(taskId, result.content.length > 0);

      console.log(`[E2E] step="${step.focus}" → ${result.content.slice(0, 80)}...`);
    }

    const summary = metrics.getSummary();
    console.log(
      `[E2E] summary: tasks=${summary.totalTasks} successRate=${summary.successRate} avgTokens≈${Math.round(summary.avgTokens)}`,
    );

    expect(summary.totalTasks).toBe(steps.length);
    expect(summary.successRate).toBe(1.0);
    expect(summary.avgTokens).toBeGreaterThan(0);
  }, 60000);
});
