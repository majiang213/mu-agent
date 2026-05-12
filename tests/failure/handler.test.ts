import { describe, it, expect } from 'vitest';
import { FailureHandler } from '../../src/failure/handler.js';
import { createFailureHandler } from '../../src/failure/index.js';

describe('FailureHandler', () => {
  describe('initialization', () => {
    it('should initialize with default config', () => {
      const handler = createFailureHandler();
      expect(handler.getCurrentLevel()).toBe(1);
    });

    it('should initialize with custom config', () => {
      const handler = createFailureHandler({ maxRetries: 5 });
      expect(handler.getCurrentLevel()).toBe(1);
    });
  });

  describe('level 1: retry', () => {
    it('should retry on tool execution error', async () => {
      const handler = createFailureHandler();
      const context = handler.createContext(
        'tool_execution',
        new Error('Tool failed'),
        'ANALYZE',
        1
      );

      const result = await handler.handleFailure(context);
      expect(result.shouldRetry).toBe(true);
      expect(result.action).toBe('retry_with_backoff');
    });
  });

  describe('level 4: human intervention', () => {
    it('should request human help when all retries exhausted', async () => {
      const handler = createFailureHandler({ maxRetries: 1 });
      const context = handler.createContext(
        'timeout',
        new Error('Operation timed out'),
        'VERIFY',
        5
      );

      const result = await handler.handleFailure(context);
      expect(result.shouldRetry).toBe(false);
      expect(result.action).toBe('request_human_help');
    });
  });

  describe('reset', () => {
    it('should reset to level 1', async () => {
      const handler = createFailureHandler({ maxRetries: 1 });
      const context = handler.createContext(
        'validation',
        new Error('Validation failed'),
        'VERIFY',
        2
      );

      await handler.handleFailure(context);
      handler.reset();
      expect(handler.getCurrentLevel()).toBe(1);
    });
  });
});
