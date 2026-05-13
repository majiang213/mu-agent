import { describe, it, expect } from 'vitest';
import { StateMachineAgent } from '../../src/core/session.js';
import { State } from '../../src/core/types.js';

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

  it('includes coding assistant identity in initial prompt', () => {
    const agent = new StateMachineAgent('qwen2.5:7b');
    const prompt = agent.generatePrompt('any task');
    expect(prompt.toLowerCase()).toContain('coding assistant');
  });

  it('prompt changes after state transition to LOCATE', () => {
    const agent = new StateMachineAgent('qwen2.5:7b');
    const analyzePrompt = agent.generatePrompt('task');
    agent.transitionTo(State.LOCATE);
    const locatePrompt = agent.generatePrompt('task');
    expect(locatePrompt).not.toBe(analyzePrompt);
    expect(locatePrompt.toLowerCase()).toContain('locate');
  });

  it('prompt changes after state transition to MODIFY', () => {
    const agent = new StateMachineAgent('qwen2.5:7b');
    agent.transitionTo(State.MODIFY);
    const prompt = agent.generatePrompt('task');
    expect(prompt.toLowerCase()).toContain('change');
  });

  it('prompt changes after state transition to VERIFY', () => {
    const agent = new StateMachineAgent('qwen2.5:7b');
    agent.transitionTo(State.VERIFY);
    const prompt = agent.generatePrompt('task');
    expect(prompt.toLowerCase()).toContain('verify');
  });

  it('adds small model constraints for 7b model', () => {
    const agent = new StateMachineAgent('qwen2.5:7b');
    const prompt = agent.generatePrompt('task');
    expect(prompt).toContain('400 tokens');
  });
});
