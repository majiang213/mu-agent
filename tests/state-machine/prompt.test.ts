import { describe, it, expect } from 'vitest';
import { StateMachineAgent } from '../../src/state-machine/agent.js';
import { State } from '../../src/state-machine/types.js';

describe('StateMachineAgent — generatePrompt', () => {
  it('returns a non-empty string', () => {
    const agent = new StateMachineAgent('qwen2.5:7b');
    const prompt = agent.generatePrompt('fix the login bug');
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('includes task description in prompt', () => {
    const agent = new StateMachineAgent('qwen2.5:7b');
    const prompt = agent.generatePrompt('fix the login bug');
    expect(prompt).toContain('fix the login bug');
  });

  it('includes current state (ANALYZE) in initial prompt', () => {
    const agent = new StateMachineAgent('qwen2.5:7b');
    const prompt = agent.generatePrompt('any task');
    expect(prompt).toContain('ANALYZE');
  });

  it('prompt changes after state transition to LOCATE', () => {
    const agent = new StateMachineAgent('qwen2.5:7b');
    const analyzePropmt = agent.generatePrompt('task');
    agent.transitionTo(State.LOCATE);
    const locatePrompt = agent.generatePrompt('task');
    expect(locatePrompt).toContain('LOCATE');
    expect(locatePrompt).not.toBe(analyzePropmt);
  });

  it('prompt changes after state transition to MODIFY', () => {
    const agent = new StateMachineAgent('qwen2.5:7b');
    agent.transitionTo(State.MODIFY);
    const prompt = agent.generatePrompt('task');
    expect(prompt).toContain('MODIFY');
  });

  it('prompt changes after state transition to VERIFY', () => {
    const agent = new StateMachineAgent('qwen2.5:7b');
    agent.transitionTo(State.VERIFY);
    const prompt = agent.generatePrompt('task');
    expect(prompt).toContain('VERIFY');
  });

  it('adds small model constraints for 7b model', () => {
    const agent = new StateMachineAgent('qwen2.5:7b');
    const prompt = agent.generatePrompt('task');
    expect(prompt).toContain('CONSTRAINTS');
  });
});
