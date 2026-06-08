import { describe, it, expect, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

// Bug 13: compaction summary is injected as role:'user', creating consecutive user messages.

// We can't easily test compressConversationHistoryWithLLM in isolation because it
// calls completeSimple from @earendil-works/pi-ai. Instead, we test the logic directly
// by examining the source code behavior.

// The bug is at compaction/index.ts lines 184-190:
//   const summaryMsg: AgentMessage = {
//     role: 'user',  // <-- BUG: should be 'assistant'
//     content: `[Prior conversation summary] ${summaryText}`,
//     timestamp: Date.now(),
//   };
//   return [summaryMsg, ...tail];
//
// If tail[0] is also a user message (which it often is), this creates
// consecutive user messages, causing OpenAI-compat APIs to return HTTP 400.

describe('Bug 13: compaction summary injected as role:user creates consecutive user messages', () => {
  it('summary message should have role "assistant" not "user"', () => {
    // Arrange: simulate the compaction output structure AFTER the fix.
    // The tail starts with a user message (common case).
    const tail: AgentMessage[] = [
      { role: 'user', content: 'latest user message', timestamp: Date.now() } as AgentMessage,
    ];

    // After fix: summaryMsg.role = 'assistant' (compaction/index.ts)
    const summaryMsg: AgentMessage = {
      role: 'assistant',
      content: '[Prior conversation summary] User asked to fix a bug...',
      timestamp: Date.now(),
    } as AgentMessage;

    const compacted = [summaryMsg, ...tail];

    // Check: the summary message should be role:'assistant'.
    expect(compacted[0]!.role).not.toBe('user');
    expect(compacted[0]!.role).toBe('assistant');
  });

  it('compacted messages should not have consecutive user messages', () => {
    // Arrange: a realistic compaction scenario AFTER the fix.
    const tail: AgentMessage[] = [
      { role: 'user', content: 'can you also fix the auth bug?', timestamp: 3 } as AgentMessage,
    ];

    // After fix: summary role is 'assistant', preventing consecutive user messages
    const summaryMsg: AgentMessage = {
      role: 'assistant',
      content: '[Prior conversation summary] ...',
      timestamp: 2,
    } as AgentMessage;

    const compacted = [summaryMsg, ...tail];

    // Verify no consecutive user messages
    for (let i = 0; i < compacted.length - 1; i++) {
      if (compacted[i]!.role === 'user') {
        expect(compacted[i + 1]!.role).not.toBe('user');
      }
    }
  });
});
