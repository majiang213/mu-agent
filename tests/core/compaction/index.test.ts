import { describe, it, expect } from 'vitest';
import { createContextCompactor } from '../../../src/core/compaction/index.js';

describe('ContextCompactor', () => {
  describe('shouldCompact', () => {
    it('should not compact small message list', () => {
      const compactor = createContextCompactor();
      const messages = Array(5).fill({ role: 'user', content: 'test' });
      expect(compactor.shouldCompact(messages)).toBe(false);
    });

    it('should compact large message list', () => {
      const compactor = createContextCompactor({ maxTokens: 100 });
      const messages = Array(15).fill({
        role: 'user',
        content: 'a'.repeat(100),
      });
      expect(compactor.shouldCompact(messages)).toBe(true);
    });
  });

  describe('compact', () => {
    it('should return original if no compaction needed', () => {
      const compactor = createContextCompactor();
      const messages = Array(5).fill({ role: 'user', content: 'test' });

      const result = compactor.compact(messages);
      expect(result.compacted).toBe(false);
      expect(result.originalCount).toBe(5);
      expect(result.compactedCount).toBe(5);
    });

    it('should compact large message list', () => {
      const compactor = createContextCompactor({ maxTokens: 50 });
      const messages = Array(15).fill({
        role: 'user',
        content: 'this is a test message with more content to exceed token limit',
      });

      const result = compactor.compact(messages);
      expect(result.compacted).toBe(true);
      expect(result.originalCount).toBe(15);
      expect(result.compactedCount).toBe(7);
      expect(result.removedCount).toBe(9);
    });
  });
});
