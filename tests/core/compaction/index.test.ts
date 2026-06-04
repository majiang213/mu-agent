import { describe, it, expect } from 'vitest';
import { createContextCompactor } from '../../../src/core/compaction/index.js';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

function userMsg(content: string): AgentMessage {
  return { role: 'user', content, timestamp: Date.now() } as AgentMessage;
}

function assistantMsg(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
    api: 'ollama' as any,
    provider: 'ollama' as any,
    model: 'test',
    usage: { input: 0, output: 0, cacheRead: 0 },
    stopReason: 'stop',
  } as AgentMessage;
}

function toolResultMsg(toolName: string, isError = false): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: 'id1',
    toolName,
    content: [{ type: 'text', text: 'file content here '.repeat(20) }],
    isError,
    timestamp: Date.now(),
  } as AgentMessage;
}

function steerMsg(prefix: string): AgentMessage {
  return { role: 'steer', content: `${prefix} some steer message content`, timestamp: Date.now() } as AgentMessage;
}

describe('ContextCompactor', () => {
  describe('shouldCompact', () => {
    it('does not compact small message list', () => {
      const c = createContextCompactor();
      const msgs = Array(5).fill(userMsg('test'));
      expect(c.shouldCompact(msgs)).toBe(false);
    });

    it('does not compact when under token limit', () => {
      const c = createContextCompactor({ maxTokens: 10000, minMessagesToCompact: 3 });
      const msgs = Array(5).fill(userMsg('short'));
      expect(c.shouldCompact(msgs)).toBe(false);
    });

    it('compacts when over token limit', () => {
      const c = createContextCompactor({ maxTokens: 50, minMessagesToCompact: 3 });
      const msgs = Array(10).fill(userMsg('a'.repeat(100)));
      expect(c.shouldCompact(msgs)).toBe(true);
    });
  });

  describe('compact', () => {
    it('returns original messages when no compaction needed', () => {
      const c = createContextCompactor();
      const msgs = Array(5).fill(userMsg('test'));
      const result = c.compact(msgs);
      expect(result.compacted).toBe(false);
      expect(result.messages).toHaveLength(5);
    });

    it('preserves head and tail, compresses middle steer messages', () => {
      const c = createContextCompactor({ maxTokens: 50, minMessagesToCompact: 5, preserveFirstN: 2, preserveLastN: 2 });
      const msgs: AgentMessage[] = [
        userMsg('first'),
        userMsg('second'),
        steerMsg('[STAGNATION'),
        steerMsg('[REMINDER]'),
        steerMsg('[STAGNATION'),
        steerMsg('[REMINDER]'),
        userMsg('a'.repeat(200)),
        userMsg('a'.repeat(200)),
        userMsg('tail1'),
        userMsg('tail2'),
      ];
      const result = c.compact(msgs);
      expect(result.compacted).toBe(true);
      expect(result.originalCount).toBe(10);
      expect(result.messages.length).toBeLessThan(10);
    });

    it('removes steer messages from middle', () => {
      const c = createContextCompactor({ maxTokens: 50, minMessagesToCompact: 5, preserveFirstN: 1, preserveLastN: 1 });
      const msgs: AgentMessage[] = [
        userMsg('first'),
        steerMsg('[STAGNATION'),
        steerMsg('[REMINDER]'),
        steerMsg('[ALREADY READ]'),
        steerMsg('[ERROR]'),
        userMsg('a'.repeat(200)),
        userMsg('last'),
      ];
      const result = c.compact(msgs);
      const contents = result.messages.map((m) => {
        const c = (m as { content?: unknown }).content;
        return typeof c === 'string' ? c : JSON.stringify(c);
      });
      expect(contents.some((t) => t.includes('[STAGNATION'))).toBe(false);
      expect(contents.some((t) => t.includes('[REMINDER]'))).toBe(false);
    });

    it('compresses toolResult to name+status', () => {
      const c = createContextCompactor({ maxTokens: 50, minMessagesToCompact: 5, preserveFirstN: 1, preserveLastN: 1 });
      const msgs: AgentMessage[] = [
        userMsg('first'),
        toolResultMsg('read', false),
        toolResultMsg('bash', true),
        userMsg('a'.repeat(200)),
        userMsg('last'),
      ];
      const result = c.compact(msgs);
      const texts = result.messages.flatMap((m) => {
        const c = (m as { content?: unknown }).content;
        if (Array.isArray(c)) return c.map((b: any) => b.text ?? '');
        return [typeof c === 'string' ? c : ''];
      });
      expect(texts.some((t) => t.includes('read✓'))).toBe(true);
      expect(texts.some((t) => t.includes('bash✗'))).toBe(true);
    });

    it('truncates long user messages in middle', () => {
      const c = createContextCompactor({ maxTokens: 50, minMessagesToCompact: 5, preserveFirstN: 1, preserveLastN: 1 });
      const longContent = 'x'.repeat(1000);
      const msgs: AgentMessage[] = [
        userMsg('first'),
        userMsg(longContent),
        userMsg(longContent),
        userMsg(longContent),
        userMsg('last'),
      ];
      const result = c.compact(msgs);
      const middleMsgs = result.messages.slice(1, -1);
      for (const m of middleMsgs) {
        const c = (m as { content?: unknown }).content;
        const text = typeof c === 'string' ? c : '';
        expect(text.length).toBeLessThanOrEqual(305);
      }
    });

    it('compresses assistant tool calls in middle', () => {
      const c = createContextCompactor({ maxTokens: 50, minMessagesToCompact: 3, preserveFirstN: 1, preserveLastN: 1 });
      const assistantWithTool: AgentMessage = {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will read the file' },
          { type: 'toolCall', id: '1', name: 'read', arguments: { filePath: 'src/foo.ts' } },
        ],
        timestamp: Date.now(),
        api: 'ollama' as any,
        provider: 'ollama' as any,
        model: 'test',
        usage: { input: 0, output: 0, cacheRead: 0 },
        stopReason: 'toolUse',
      } as AgentMessage;
      const msgs: AgentMessage[] = [userMsg('first'), assistantWithTool, userMsg('a'.repeat(200)), userMsg('last')];
      const result = c.compact(msgs);
      const texts = result.messages.flatMap((m) => {
        const c = (m as { content?: unknown }).content;
        if (Array.isArray(c)) return c.map((b: any) => b.text ?? '');
        return [typeof c === 'string' ? c : ''];
      });
      expect(texts.some((t) => t.includes('[tool:read]'))).toBe(true);
    });
  });

  describe('estimateTokens', () => {
    it('estimates tokens using gpt-tokenizer (accurate count)', () => {
      const c = createContextCompactor();
      const msgs = [userMsg('a'.repeat(400))];
      const tokens = c.estimateTokens(msgs);
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(400);
    });
  });

  describe('in-loop compaction (transformContext pattern)', () => {
    it('does not compact when messages are within budget', () => {
      const budget = 24000;
      const c = createContextCompactor({ maxTokens: budget });
      const msgs = Array(8).fill(userMsg('short message'));
      const result = c.compact(msgs);
      expect(result.compacted).toBe(false);
      expect(result.messages).toHaveLength(8);
    });

    it('compacts middle when messages exceed in-loop budget', () => {
      const budget = 200;
      const c = createContextCompactor({
        maxTokens: budget,
        minMessagesToCompact: 5,
        preserveFirstN: 2,
        preserveLastN: 2,
      });
      const msgs: AgentMessage[] = [
        userMsg('system context'),
        userMsg('task description'),
        toolResultMsg('read'),
        toolResultMsg('read'),
        toolResultMsg('read'),
        toolResultMsg('grep'),
        userMsg('a'.repeat(500)),
        userMsg('latest message'),
      ];
      const result = c.compact(msgs);
      expect(result.compacted).toBe(true);
      expect(result.messages[0]).toEqual(msgs[0]);
      expect(result.messages[1]).toEqual(msgs[1]);
      expect(result.messages.at(-1)).toEqual(msgs.at(-1));
      expect(result.messages.at(-2)).toEqual(msgs.at(-2));
    });

    it('steer messages are removed during in-loop compaction', () => {
      const budget = 100;
      const c = createContextCompactor({
        maxTokens: budget,
        minMessagesToCompact: 5,
        preserveFirstN: 1,
        preserveLastN: 2,
      });
      const msgs: AgentMessage[] = [
        userMsg('task'),
        steerMsg('[STAGNATION DETECTED]'),
        steerMsg('[REMINDER]'),
        toolResultMsg('read'),
        userMsg('a'.repeat(300)),
        userMsg('latest'),
      ];
      const result = c.compact(msgs);
      const allContent = result.messages
        .map((m) => {
          const content = (m as { content?: unknown }).content;
          return typeof content === 'string' ? content : JSON.stringify(content);
        })
        .join(' ');
      expect(allContent).not.toContain('[STAGNATION DETECTED]');
      expect(allContent).not.toContain('[REMINDER]');
    });
  });
});
