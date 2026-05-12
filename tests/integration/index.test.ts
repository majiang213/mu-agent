import { describe, it, expect, beforeAll } from 'vitest';
import { ConfigManager } from '../../src/config/manager.js';
import { StateMachineAgent } from '../../src/state-machine/agent.js';
import { TaskScheduler } from '../../src/decomposition/scheduler.js';
import { createFailureHandler } from '../../src/failure/index.js';
import { createCognitiveGate } from '../../src/cognitive/index.js';
import { createASTLocator } from '../../src/ast-locator/index.js';
import { createSafeModifier } from '../../src/safety/index.js';

describe('Integration Tests', () => {
  beforeAll(() => {
    // Reset singletons
    ConfigManager.getInstance().destroy();
  });

  describe('Module Integration', () => {
    it('should initialize all modules', () => {
      const configManager = ConfigManager.getInstance();
      const config = configManager.initialize();

      expect(config).toBeDefined();
      expect(config.system).toBeDefined();
      expect(config.runtime).toBeDefined();

      const stateMachine = new StateMachineAgent('qwen2.5:7b');
      expect(stateMachine.getCurrentState()).toBe('ANALYZE');

      const failureHandler = createFailureHandler();
      expect(failureHandler.getCurrentLevel()).toBe(1);

      const cognitiveGate = createCognitiveGate();
      expect(cognitiveGate.getStats()).toEqual({ toolCalls: 0, errors: 0 });

      const astLocator = createASTLocator();
      expect(astLocator).toBeDefined();

      const safeModifier = createSafeModifier();
      expect(safeModifier).toBeDefined();
    });

    it('should create task scheduler', () => {
      const scheduler = new TaskScheduler();
      expect(scheduler.getTasks()).toEqual([]);
    });
  });

  describe('End-to-End Flow', () => {
    it('should complete a simple task flow', async () => {
      // Initialize
      const configManager = ConfigManager.getInstance();
      configManager.initialize();

      const stateMachine = new StateMachineAgent('qwen2.5:7b');
      const scheduler = new TaskScheduler();

      // Create task
      const tasks = await scheduler.decompose('Simple test task');
      expect(tasks.length).toBeGreaterThan(0);

      // Verify initial state
      expect(stateMachine.getCurrentState()).toBe('ANALYZE');

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

    it('should handle tool calls with cognitive gate', () => {
      const cognitiveGate = createCognitiveGate();

      // Record some tool calls
      cognitiveGate.recordToolCall({
        tool: 'read',
        input: { path: 'test.ts' },
        output: {},
        timestamp: Date.now(),
      });

      const check1 = cognitiveGate.check();
      expect(check1.detected).toBe(false);

      // Record more calls to trigger detection
      for (let i = 0; i < 3; i++) {
        cognitiveGate.recordToolCall({
          tool: 'read',
          input: { path: 'test.ts' },
          output: {},
          timestamp: Date.now(),
        });
      }

      const check2 = cognitiveGate.check();
      expect(check2.detected).toBe(true);
      expect(check2.type).toBe('repeated_tool');
    });
  });
});
