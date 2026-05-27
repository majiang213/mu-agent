import { describe, it, expect, beforeEach } from 'vitest';
import { createStagnationDetector } from '../../../src/core/cognitive/index.js';

describe('StagnationDetector', () => {
  let gate: ReturnType<typeof createStagnationDetector>;

  beforeEach(() => {
    gate = createStagnationDetector();
  });

  describe('repeated tool calls', () => {
    it('should detect repeated tool calls', () => {
      for (let i = 0; i < 3; i++) {
        gate.recordToolCall({
          tool: 'read',
          input: { path: 'test.ts' },
          output: {},
          timestamp: Date.now(),
        });
      }

      const result = gate.check();
      expect(result.detected).toBe(true);
      expect(result.type).toBe('repeated_tool');
    });

    it('should not detect with different tool calls', () => {
      gate.recordToolCall({
        tool: 'read',
        input: { path: 'test1.ts' },
        output: {},
        timestamp: Date.now(),
      });
      gate.recordToolCall({
        tool: 'read',
        input: { path: 'test2.ts' },
        output: {},
        timestamp: Date.now(),
      });

      const result = gate.check();
      expect(result.detected).toBe(false);
    });
  });

  describe('repeated errors', () => {
    it('should detect repeated errors', () => {
      gate.recordError('File not found');
      gate.recordError('File not found');

      const result = gate.check();
      expect(result.detected).toBe(true);
      expect(result.type).toBe('repeated_error');
    });

    it('different error strings do not trigger repeated_error', () => {
      gate.recordError('tool_error:bash');
      gate.recordError('tool_error:read');

      const result = gate.check();
      expect(result.detected).toBe(false);
    });
  });

  describe('no progress', () => {
    it('should detect only reading without changes', () => {
      for (let i = 0; i < 5; i++) {
        gate.recordToolCall({
          tool: 'read',
          input: { path: `test${i}.ts` },
          output: {},
          timestamp: Date.now(),
        });
      }

      const result = gate.check();
      expect(result.detected).toBe(true);
      expect(result.type).toBe('no_progress');
    });
  });

  describe('reset', () => {
    it('should clear history', () => {
      gate.recordToolCall({
        tool: 'read',
        input: { path: 'test.ts' },
        output: {},
        timestamp: Date.now(),
      });

      gate.reset();
      const stats = gate.getStats();
      expect(stats.toolCalls).toBe(0);
    });
  });
});
