import { describe, it, expect } from 'vitest';
import { State } from '../../src/core/types.js';
import { StateMachineAgent } from '../../src/core/agent/state-machine.js';
import { ReactAgent } from '../../src/core/agent/index.js';
import { StagnationDetector } from '../../src/core/cognitive/index.js';
import { ASTLocator } from '../../src/tool/locator.js';
import { SafeModifier } from '../../src/tool/safety/index.js';

describe('Integration Tests', () => {
  describe('Module Integration', () => {
    it('should initialize all modules', () => {
      const stateMachine = new StateMachineAgent('qwen2.5:7b');
      expect(stateMachine.getCurrentState()).toBe('REASON');

      const stagnationDetector = new StagnationDetector();
      expect(stagnationDetector.check().detected).toBe(false);

      const astLocator = new ASTLocator();
      expect(astLocator).toBeDefined();

      const safeModifier = new SafeModifier();
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
      stateMachine.transitionTo(State.LOCATE);
      expect(stateMachine.getCurrentState()).toBe('LOCATE');

      stateMachine.transitionTo(State.MODIFY);
      expect(stateMachine.getCurrentState()).toBe('MODIFY');

      stateMachine.transitionTo(State.VERIFY);
      expect(stateMachine.getCurrentState()).toBe('VERIFY');

      stateMachine.transitionTo(State.DONE);
      expect(stateMachine.getCurrentState()).toBe('DONE');
    });

    it('should handle tool calls with stagnation detector', () => {
      const stagnationDetector = new StagnationDetector();

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
      if (check2.detected) {
        expect(check2.type).toBe('repeated_tool');
      }
    });
  });
});
