import { describe, it, expect, beforeAll } from 'vitest';
import { ReactAgent } from '../../src/core/agent/index.js';
import { StateMachineAgent } from '../../src/core/session/index.js';
import { MetricsCollector } from '../../src/tui/metrics.js';
import { State, type Step } from '../../src/core/types.js';
import { loadConfig, ConfigNotFoundError } from '../../src/config/loader.js';
import type { Config } from '../../src/config/types.js';

// Load config at module level — null means no config file found (skip Ollama tests)
let config: Config | null = null;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigNotFoundError)) throw err;
}

const MODEL = config?.model.name ?? 'unknown';
const BASE_URL = config?.model.baseUrl ?? '';

async function isOllamaRunning(): Promise<boolean> {
  try {
    const url = BASE_URL.replace(/\/v1\/?$/, '');
    const res = await fetch(`${url}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

// Tests that do NOT require config or Ollama
describe('StateMachine + Metrics (no Ollama required)', () => {
  it('StateMachineAgent.getAllowedTools() 按状态限制工具', () => {
    // Note: 'complete' is a runtime-injected tool (buildCompleteTool), not in the static allTools list.
    // getAllowedTools() only returns static tools filtered by allowedTools config.
    const agent = new StateMachineAgent(MODEL);

    agent.transitionTo(State.VERIFY);
    const verifyTools = agent.getAllowedTools().map((t) => t.name);
    expect(verifyTools).toContain('bash');
    expect(verifyTools).not.toContain('edit');

    agent.transitionTo(State.MODIFY);
    const modifyTools = agent.getAllowedTools().map((t) => t.name);
    expect(modifyTools).toContain('edit');
    expect(modifyTools).toContain('write');
    expect(modifyTools).not.toContain('bash');
  });

  it('MetricsCollector: 追踪多步骤任务生命周期', () => {
    const metrics = new MetricsCollector();
    const steps: Step[] = [
      { state: State.LOCATE, focus: '定位登录 bug' },
      { state: State.MODIFY, focus: '修复 bug' },
    ];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const taskId = `step-${i}`;
      metrics.startTask(taskId);
      metrics.recordStateEntry(taskId, step.state);
      metrics.recordLLMCall(taskId, 400, 150);
      metrics.recordToolCall(taskId, 'read');
      metrics.recordStateExit(taskId, step.state);
      metrics.finishTask(taskId, true);
    }

    const summary = metrics.getSummary();
    console.log(
      `[Metrics] tasks=${summary.totalTasks} successRate=${summary.successRate} avgTokens≈${Math.round(summary.avgTokens)}`,
    );

    expect(summary.totalTasks).toBe(steps.length);
    expect(summary.successRate).toBe(1.0);
    expect(summary.avgTokens).toBeGreaterThan(0);
  });

  it('完整流程: 动态步骤 → 状态机 → Metrics 汇总', () => {
    const metrics = new MetricsCollector();
    const agent = new StateMachineAgent(MODEL);

    const steps: Step[] = [
      { state: State.LOCATE, focus: '定位 auth.ts 里的 login 函数' },
      { state: State.MODIFY, focus: '添加参数校验' },
      { state: State.VERIFY, focus: '运行 npm test' },
    ];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const taskId = `e2e-step-${i}`;

      agent.transitionTo(step.state);
      const prompt = agent.generatePrompt(step.focus);

      metrics.startTask(taskId);
      metrics.recordStateEntry(taskId, step.state);
      metrics.recordLLMCall(taskId, prompt.length, 200);
      metrics.recordStateExit(taskId, step.state);
      metrics.finishTask(taskId, true);

      console.log(`[E2E] step="${step.focus}" state=${step.state} promptLen=${prompt.length}`);
    }

    const summary = metrics.getSummary();
    expect(summary.totalTasks).toBe(steps.length);
    expect(summary.successRate).toBe(1.0);
    expect(summary.avgTokens).toBeGreaterThan(0);
  });
});

// Tests that require config + running Ollama
describe.skipIf(config === null)('Real Ollama Integration', () => {
  beforeAll(async () => {
    const running = await isOllamaRunning();
    if (!running) {
      throw new Error(
        `Ollama is not running at ${BASE_URL}. Start Ollama and ensure model "${MODEL}" is available before running these tests.`,
      );
    }
  });

  it('StateMachineAgent.generatePrompt() 包含状态指令', () => {
    const agent = new StateMachineAgent(MODEL);
    agent.transitionTo(State.LOCATE);
    const prompt = agent.generatePrompt('找到 src/auth.ts 里的 login 函数');
    expect(prompt.toLowerCase()).toContain('coding assistant');
    expect(prompt).toBeTruthy();
  });

  it('ReactAgent.run(): 简单问答任务返回 success', async () => {
    const agent = new ReactAgent();
    const result = await agent.run('你好，简单回复一句话即可', config!);

    console.log('[ReactAgent ANSWER] output:', result.output?.slice(0, 200));
    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
  }, 60000);

  it('ReactAgent.run(): DIAGNOSE 类型任务能正常执行', async () => {
    const agent = new ReactAgent();
    const result = await agent.run('请解释 TypeScript 里 interface 和 type 有什么区别，简短回答', config!);

    console.log('[ReactAgent RESEARCH] output:', result.output?.slice(0, 300));
    expect(result.success).toBe(true);
  }, 60000);
});
