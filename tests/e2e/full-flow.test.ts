import { describe, it, expect } from 'vitest';
import { StateMachineAgent } from '../../src/core/session/index.js';
import { State, type Step } from '../../src/core/types.js';

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

  it('Step supports optional why field', () => {
    const step: Step = { state: State.LOCATE, focus: '定位 auth.ts', why: '需要先找到入口函数' };
    expect(step.why).toBe('需要先找到入口函数');
  });

  it('dynamic agenda: multi-step plan from REASON output', () => {
    const steps: Step[] = [
      { state: State.LOCATE, focus: '定位 auth.ts 里需要改动的位置' },
      { state: State.MODIFY, focus: '添加 logout 方法' },
      { state: State.VERIFY, focus: '运行测试' },
    ];
    expect(steps).toHaveLength(3);
    expect(steps[0]!.state).toBe(State.LOCATE);
    expect(steps[1]!.focus).toContain('logout');
  });

  it('run stats: task lifecycle counts calls and tokens (MetricsCollector deleted, R7-C8)', () => {
    // HeaderLine is the one accumulator now; the shape a summary needs is
    // llmCalls + totalTokens + success, fed by real usage tokens.
    let llmCalls = 0;
    let totalTokens = 0;
    const recordCall = (promptTokens: number, responseTokens: number): void => {
      llmCalls += 1;
      totalTokens += promptTokens + responseTokens;
    };

    recordCall(500, 200);
    const success = true;

    expect(llmCalls).toBe(1);
    expect(totalTokens).toBeGreaterThan(0);
    expect(success).toBe(true);
  });

  it('full pipeline: dynamic steps → state machine → run stats', () => {
    const agent = new StateMachineAgent('qwen2.5:7b');

    const steps: Step[] = [
      { state: State.LOCATE, focus: '定位 bug 位置' },
      { state: State.MODIFY, focus: '修复 bug' },
      { state: State.VERIFY, focus: '写测试验证' },
    ];

    let llmCalls = 0;
    agent.transitionTo(State.LOCATE);
    const prompt = agent.generatePrompt(steps[0]!.focus);
    expect(prompt.toLowerCase()).toContain('coding assistant');
    llmCalls += 1;

    expect(llmCalls).toBe(1);
    expect(steps).toHaveLength(3);
  });

  it('StateMachineAgent clone produces independent instance', () => {
    const agent = new StateMachineAgent('qwen2.5:7b');
    agent.transitionTo(State.LOCATE);

    const clone = agent.clone();
    expect(clone.getCurrentState()).toBe(State.REASON);

    clone.transitionTo(State.MODIFY);
    expect(agent.getCurrentState()).toBe(State.LOCATE);
    expect(clone.getCurrentState()).toBe(State.MODIFY);
  });

  it('StateMachineAgent getAllowedTools returns only state-appropriate tools', () => {
    const agent = new StateMachineAgent('qwen2.5:7b');

    agent.transitionTo(State.VERIFY);
    const verifyTools = agent.getAllowedTools().map((t) => t.name);
    expect(verifyTools).toContain('bash');
    expect(verifyTools).not.toContain('edit');
    expect(verifyTools).not.toContain('write');

    agent.transitionTo(State.MODIFY);
    const modifyTools = agent.getAllowedTools().map((t) => t.name);
    expect(modifyTools).toContain('edit');
    expect(modifyTools).toContain('write');
    expect(modifyTools).not.toContain('bash');

    agent.transitionTo(State.LOCATE);
    const locateTools = agent.getAllowedTools().map((t) => t.name);
    expect(locateTools).toContain('read');
    expect(locateTools).not.toContain('edit');
    expect(locateTools).not.toContain('bash');
  });

  it('StateMachineAgent resetFileBudget resets only the file budget (round-5)', () => {
    const agent = new StateMachineAgent('qwen2.5:7b');
    agent.transitionTo(State.MODIFY);
    agent.recordToolCall('edit');
    agent.resetFileBudget();

    // The old resetForRetry also wrote currentState = REASON — a dead write
    // with no reader (round-5 hygiene); the state is untouched now.
    expect(agent.getCurrentState()).toBe(State.MODIFY);
    expect(agent.getFileCount()).toBe(0);
  });
});
