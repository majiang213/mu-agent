import { describe, it, expect } from 'vitest';
import { compactLoopMessages } from '../../../src/core/compaction/index.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

/**
 * compactLoopMessages — the collapsed in-loop compaction function (round-4
 * hygiene). The policy constants are fixed: preserve first 2 + last 6,
 * minimum 10 messages before compaction triggers. Tests build scenarios
 * against those constants.
 */

function userMsg(content: string): AgentMessage {
  return { role: 'user', content, timestamp: Date.now() } as AgentMessage;
}

function assistantMsg(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
    api: 'ollama' as never,
    provider: 'ollama' as never,
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
  } as AgentMessage;
}

function assistantToolCallMsg(toolName: string): AgentMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'I will read the file' },
      { type: 'toolCall', id: '1', name: toolName, arguments: { filePath: 'src/foo.ts' } },
    ],
    timestamp: Date.now(),
    api: 'ollama' as never,
    provider: 'ollama' as never,
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
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

function textsOf(messages: AgentMessage[]): string[] {
  return messages.flatMap((m) => {
    const c = (m as { content?: unknown }).content;
    if (Array.isArray(c)) return c.map((b: { text?: string }) => b.text ?? '');
    return [typeof c === 'string' ? c : ''];
  });
}

describe('compactLoopMessages', () => {
  it('returns the input unchanged when under the message minimum', () => {
    const msgs = Array(5).fill(userMsg('test'));
    const result = compactLoopMessages(msgs, 1);
    expect(result).toBe(msgs);
    expect(result).toHaveLength(5);
  });

  it('returns the input unchanged when within the token budget', () => {
    const msgs = Array(12).fill(userMsg('short'));
    const result = compactLoopMessages(msgs, 24000);
    expect(result).toBe(msgs);
    expect(result).toHaveLength(12);
  });

  it('preserves head 2 + tail 6 and compresses the middle when over budget', () => {
    const msgs: AgentMessage[] = [
      userMsg('first'),
      userMsg('second'),
      toolResultMsg('read'),
      steerMsg('[STAGNATION]'),
      userMsg('a'.repeat(400)),
      assistantMsg('b'.repeat(300)),
      userMsg('t1'),
      userMsg('t2'),
      userMsg('t3'),
      userMsg('t4'),
      userMsg('t5'),
      userMsg('t6'),
    ];
    const result = compactLoopMessages(msgs, 50);
    expect(result.length).toBeLessThan(msgs.length);
    expect(result[0]).toEqual(msgs[0]);
    expect(result[1]).toEqual(msgs[1]);
    expect(result.slice(-6)).toEqual(msgs.slice(-6));
  });

  it('drops steer messages from the middle', () => {
    const msgs: AgentMessage[] = [
      userMsg('first'),
      userMsg('second'),
      steerMsg('[STAGNATION]'),
      steerMsg('[REMINDER]'),
      userMsg('a'.repeat(400)),
      userMsg('b'.repeat(400)),
      userMsg('t1'),
      userMsg('t2'),
      userMsg('t3'),
      userMsg('t4'),
      userMsg('t5'),
      userMsg('t6'),
    ];
    const result = compactLoopMessages(msgs, 50);
    const all = textsOf(result).join(' ');
    expect(all).not.toContain('[STAGNATION]');
    expect(all).not.toContain('[REMINDER]');
  });

  it('compresses middle toolResults to name+status', () => {
    const msgs: AgentMessage[] = [
      userMsg('first'),
      userMsg('second'),
      toolResultMsg('read', false),
      toolResultMsg('bash', true),
      userMsg('a'.repeat(400)),
      userMsg('b'.repeat(400)),
      userMsg('t1'),
      userMsg('t2'),
      userMsg('t3'),
      userMsg('t4'),
      userMsg('t5'),
      userMsg('t6'),
    ];
    const result = compactLoopMessages(msgs, 50);
    const texts = textsOf(result);
    expect(texts.some((t) => t.includes('read✓'))).toBe(true);
    expect(texts.some((t) => t.includes('bash✗'))).toBe(true);
  });

  it('truncates long middle user messages to ~300 chars', () => {
    const longContent = 'x'.repeat(1000);
    const msgs: AgentMessage[] = [
      userMsg('first'),
      userMsg('second'),
      userMsg(longContent),
      userMsg(longContent),
      userMsg('c'.repeat(400)),
      userMsg('d'.repeat(400)),
      userMsg('t1'),
      userMsg('t2'),
      userMsg('t3'),
      userMsg('t4'),
      userMsg('t5'),
      userMsg('t6'),
    ];
    const result = compactLoopMessages(msgs, 50);
    for (const m of result.slice(2, -6)) {
      const c = (m as { content?: unknown }).content;
      const text = typeof c === 'string' ? c : '';
      expect(text.length).toBeLessThanOrEqual(305);
    }
  });

  it('compresses middle assistant tool calls to [tool:name]', () => {
    const msgs: AgentMessage[] = [
      userMsg('first'),
      userMsg('second'),
      assistantToolCallMsg('read'),
      userMsg('a'.repeat(400)),
      userMsg('b'.repeat(400)),
      userMsg('c'.repeat(400)),
      userMsg('t1'),
      userMsg('t2'),
      userMsg('t3'),
      userMsg('t4'),
      userMsg('t5'),
      userMsg('t6'),
    ];
    const result = compactLoopMessages(msgs, 50);
    expect(textsOf(result).some((t) => t.includes('[tool:read]'))).toBe(true);
  });

  it('matches the in-loop transformContext pattern: budget breach compacts, no breach passes through', () => {
    const within = Array(12).fill(userMsg('short message'));
    expect(compactLoopMessages(within, 24000)).toHaveLength(12);

    const over: AgentMessage[] = [
      userMsg('system context'),
      userMsg('task description'),
      toolResultMsg('read'),
      toolResultMsg('grep'),
      userMsg('a'.repeat(500)),
      userMsg('b'.repeat(500)),
      userMsg('t1'),
      userMsg('t2'),
      userMsg('t3'),
      userMsg('t4'),
      userMsg('t5'),
      userMsg('t6'),
    ];
    const compacted = compactLoopMessages(over, 200);
    // No steer messages to drop, so the message COUNT holds — compaction
    // shrinks the middle's content, not the list length.
    const sizeOf = (ms: AgentMessage[]) => textsOf(ms).join('').length;
    expect(sizeOf(compacted)).toBeLessThan(sizeOf(over));
    expect(compacted[0]).toEqual(over[0]);
    expect(compacted.at(-1)).toEqual(over.at(-1));
  });
});
