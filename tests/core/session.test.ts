import { describe, it, expect } from 'vitest';
import { StateMachineAgent } from '../../src/core/session.js';
import { State } from '../../src/core/types.js';

describe('StateMachineAgent', () => {
  describe('initialization', () => {
    it('should initialize with correct state', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      expect(agent.getCurrentState()).toBe(State.REASON);
    });

    it('should detect small model tier', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      const params = agent.getModelParams();
      expect(params.tier).toBe('SMALL');
      expect(params.maxFilesPerTask).toBe(2);
    });

    it('should detect medium model tier', () => {
      const agent = new StateMachineAgent('qwen2.5:13b');
      const params = agent.getModelParams();
      expect(params.tier).toBe('MEDIUM');
    });
  });

  describe('state transitions', () => {
    it('should transition between states', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      expect(agent.getCurrentState()).toBe(State.REASON);

      agent.transitionTo(State.LOCATE);
      expect(agent.getCurrentState()).toBe(State.LOCATE);
    });

    it('should reset iteration on transition', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      agent.incrementIteration();
      agent.incrementIteration();
      expect(agent.getIteration()).toBe(2);

      agent.transitionTo(State.LOCATE);
      expect(agent.getIteration()).toBe(0);
    });
  });

  describe('tool management', () => {
    it('should return allowed tools for current state', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      agent.transitionTo(State.ANALYZE);
      const tools = agent.getAllowedTools();
      expect(tools.length).toBeGreaterThan(0);
    });
  });

  describe('file modification tracking', () => {
    it('should track file modifications', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      expect(agent.canModifyMoreFiles()).toBe(true);

      agent.recordToolCall('edit', { path: 'test.ts' }, {});
      expect(agent.canModifyMoreFiles()).toBe(true);

      agent.recordToolCall('write', { path: 'test2.ts' }, {});
      expect(agent.canModifyMoreFiles()).toBe(false);
    });
  });
});
