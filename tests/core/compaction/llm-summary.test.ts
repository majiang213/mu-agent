import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';

const generateSummaryMock = vi.fn();

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  return {
    ...original,
    generateSummary: (...args: unknown[]) => generateSummaryMock(...args),
  };
});

import { compressConversationHistoryWithLLM } from '../../../src/core/compaction/index.js';

/**
 * Gap 86: the LLM summary call is pi's generateSummary; mu-agent keeps only
 * trigger/splice policy (trigger >16 messages, summary + last 8, steer
 * filtered before the call, failure falls back to the original list).
 */

const MODEL = { contextWindow: 100000, maxTokens: 8192 } as Model<'openai-completions'>;

function userMsg(content: string, ts: number): AgentMessage {
  return { role: 'user', content, timestamp: ts } as AgentMessage;
}

function steerMsg(content: string, ts: number): AgentMessage {
  return { role: 'steer', content, timestamp: ts } as unknown as AgentMessage;
}

beforeEach(() => {
  generateSummaryMock.mockReset();
  generateSummaryMock.mockResolvedValue('summary from pi');
});

describe('compressConversationHistoryWithLLM (pi generateSummary)', () => {
  it('returns input unchanged when under the trigger', async () => {
    const msgs = Array.from({ length: 5 }, (_, i) => userMsg('short', i));
    const result = await compressConversationHistoryWithLLM(msgs, MODEL);
    expect(result).toBe(msgs);
    expect(generateSummaryMock).not.toHaveBeenCalled();
  });

  it('summarizes head via generateSummary and keeps the last 8 messages', async () => {
    const msgs = Array.from({ length: 20 }, (_, i) => userMsg(`msg ${i}`, i));
    const result = await compressConversationHistoryWithLLM(msgs, MODEL);

    expect(generateSummaryMock).toHaveBeenCalledTimes(1);
    const [headArg, modelArg] = generateSummaryMock.mock.calls[0] as [AgentMessage[], unknown];
    expect(headArg).toHaveLength(12); // 20 - 8 tail
    expect(modelArg).toBe(MODEL);

    expect(result).toHaveLength(9); // summary + 8 tail
    expect(result[0]!.role).toBe('assistant');
    const summaryContent = (result[0] as { content?: unknown }).content;
    expect(summaryContent).toContain('[Prior conversation summary]');
    expect(summaryContent).toContain('summary from pi');
    expect(result.slice(1)).toEqual(msgs.slice(-8));
  });

  it('filters steer messages out of the generateSummary head', async () => {
    const msgs: AgentMessage[] = [
      ...Array.from({ length: 10 }, (_, i) => userMsg(`u${i}`, i)),
      steerMsg('[STAGNATION] x', 10),
      steerMsg('[REMINDER] y', 11),
      ...Array.from({ length: 8 }, (_, i) => userMsg(`t${i}`, 12 + i)),
    ];
    await compressConversationHistoryWithLLM(msgs, MODEL);

    const [headArg] = generateSummaryMock.mock.calls[0] as [AgentMessage[]];
    expect(headArg.some((m) => (m.role as string) === 'steer')).toBe(false);
    expect(headArg).toHaveLength(10);
  });

  it('falls back to the original messages when generateSummary throws', async () => {
    generateSummaryMock.mockRejectedValue(new Error('LLM down'));
    const msgs = Array.from({ length: 20 }, (_, i) => userMsg(`msg ${i}`, i));
    const result = await compressConversationHistoryWithLLM(msgs, MODEL);
    expect(result).toBe(msgs);
  });
});
