import { describe, it, expect, beforeEach } from 'vitest';
import { StagnationDetector } from '../../../src/core/cognitive/index.js';

describe('StagnationDetector', () => {
  let gate: StagnationDetector;

  beforeEach(() => {
    gate = new StagnationDetector();
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
      expect(result).toMatchObject({ detected: true, type: 'repeated_tool' });
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
      expect(result).toMatchObject({ detected: true, type: 'repeated_error' });
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
      expect(result).toMatchObject({ detected: true, type: 'no_progress' });
    });
  });

  describe('reset', () => {
    it('should clear history', () => {
      for (let i = 0; i < 3; i++) {
        gate.recordToolCall({
          tool: 'read',
          input: { path: 'test.ts' },
          output: {},
          timestamp: Date.now(),
        });
      }
      expect(gate.check().detected).toBe(true);

      gate.reset();
      expect(gate.check().detected).toBe(false);
    });
  });
});
