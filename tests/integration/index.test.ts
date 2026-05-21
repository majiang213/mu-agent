import { describe, it, expect } from 'vitest';
import { StateMachineAgent } from '../../src/core/session.js';
import { ReactAgent } from '../../src/core/agent.js';
import { createFailureHandler } from '../../src/core/failure/index.js';
import { createStagnationDetector } from '../../src/core/cognitive/index.js';
import { createASTLocator } from '../../src/tool/locator.js';
import { createSafeModifier } from '../../src/tool/safety/index.js';

describe('Integration Tests', () => {
  describe('Module Integration', () => {
    it('should initialize all modules', () => {
      const stateMachine = new StateMachineAgent('qwen2.5:7b');
      expect(stateMachine.getCurrentState()).toBe('REASON');

      const failureHandler = createFailureHandler();
      expect(failureHandler.getCurrentLevel()).toBe(1);

      const stagnationDetector = createStagnationDetector();
      expect(stagnationDetector.getStats()).toEqual({ toolCalls: 0, errors: 0 });

      const astLocator = createASTLocator();
      expect(astLocator).toBeDefined();

      const safeModifier = createSafeModifier();
      expect(safeModifier).toBeDefined();
    });

    it('should create react agent', () => {
      const agent = new ReactAgent();
      expect(agent).toBeDefined();
    });
  });

  describe('End-to-End Flow', () => {
    it('should complete a simple task flow', async () => {
      const stateMachine = new StateMachineAgent('qwen2.5:7b');

      expect(stateMachine.getCurrentState()).toBe('REASON');

      // Simulate state transitions
      stateMachine.transitionTo('LOCATE');
      expect(stateMachine.getCurrentState()).toBe('LOCATE');

      stateMachine.transitionTo('MODIFY');
      expect(stateMachine.getCurrentState()).toBe('MODIFY');

      stateMachine.transitionTo('VERIFY');
      expect(stateMachine.getCurrentState()).toBe('VERIFY');

      stateMachine.transitionTo('DONE');
      expect(stateMachine.getCurrentState()).toBe('DONE');
    });

    it('should handle tool calls with stagnation detector', () => {
      const stagnationDetector = createStagnationDetector();

      stagnationDetector.recordToolCall({
        tool: 'read',
        input: { path: 'test.ts' },
        output: {},
        timestamp: Date.now(),
      });

      const check1 = stagnationDetector.check();
      expect(check1.detected).toBe(false);

      for (let i = 0; i < 3; i++) {
        stagnationDetector.recordToolCall({
          tool: 'read',
          input: { path: 'test.ts' },
          output: {},
          timestamp: Date.now(),
        });
      }

      const check2 = stagnationDetector.check();
      expect(check2.detected).toBe(true);
      expect(check2.type).toBe('repeated_tool');
    });
  });
});
