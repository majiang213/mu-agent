import { describe, it, expect, vi, beforeEach } from 'vitest';
import { State } from '../../src/core/types.js';
import type { StateContext } from '../../src/core/types.js';

vi.mock('../../src/provider/llm.js', () => {
  return {
    LLMConnector: vi.fn().mockImplementation(() => ({
      generate: vi.fn().mockResolvedValue({ content: '{"summary":"test"}', toolCalls: [] }),
    })),
  };
});

describe('LLMService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('can be instantiated without throwing', async () => {
    const { LLMService } = await import('../../src/provider/llm-service.js');
    expect(() => new LLMService('ollama', 'qwen2.5:7b')).not.toThrow();
  });

  it('calls connector.generate when generate() is invoked', async () => {
    const { LLMConnector } = await import('../../src/provider/llm.js');
    const mockGenerate = vi.fn().mockResolvedValue({ content: 'response', toolCalls: [] });
    (LLMConnector as ReturnType<typeof vi.fn>).mockImplementation(() => ({ generate: mockGenerate }));

    const { LLMService } = await import('../../src/provider/llm-service.js');
    const service = new LLMService('ollama', 'qwen2.5:7b');

    const context: StateContext = {
      state: State.ANALYZE,
      task: 'fix bug',
      history: [],
      availableTools: [],
    };

    await service.generate(context, 'fix the login bug');
    expect(mockGenerate).toHaveBeenCalledOnce();
  });

  it('returns content and toolCalls from connector response', async () => {
    const { LLMConnector } = await import('../../src/provider/llm.js');
    (LLMConnector as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockResolvedValue({ content: 'hello', toolCalls: [{ tool: 'read', input: {}, output: null, timestamp: 0 }] }),
    }));

    const { LLMService } = await import('../../src/provider/llm-service.js');
    const service = new LLMService('ollama', 'qwen2.5:7b');

    const context: StateContext = {
      state: State.LOCATE,
      task: 'find function',
      history: [],
      availableTools: [],
    };

    const result = await service.generate(context, 'find function');
    expect(result.content).toBe('hello');
    expect(result.toolCalls).toHaveLength(1);
  });

  it('passes systemPrompt containing state name to connector', async () => {
    const { LLMConnector } = await import('../../src/provider/llm.js');
    const mockGenerate = vi.fn().mockResolvedValue({ content: '', toolCalls: [] });
    (LLMConnector as ReturnType<typeof vi.fn>).mockImplementation(() => ({ generate: mockGenerate }));

    const { LLMService } = await import('../../src/provider/llm-service.js');
    const service = new LLMService('ollama', 'qwen2.5:7b');

    const context: StateContext = {
      state: State.MODIFY,
      task: 'edit file',
      history: [],
      availableTools: [],
    };

    await service.generate(context, 'edit file');
    const [systemPrompt] = mockGenerate.mock.calls[0] as [string, string];
    expect(systemPrompt).toContain('MODIFY');
  });

  it('accepts optional baseUrl parameter', async () => {
    const { LLMService } = await import('../../src/provider/llm-service.js');
    expect(() => new LLMService('ollama', 'qwen2.5:7b', 'http://localhost:11434')).not.toThrow();
  });

  it('propagates connector errors', async () => {
    const { LLMConnector } = await import('../../src/provider/llm.js');
    (LLMConnector as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      generate: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
    }));

    const { LLMService } = await import('../../src/provider/llm-service.js');
    const service = new LLMService('ollama', 'qwen2.5:7b');

    const context: StateContext = {
      state: State.ANALYZE,
      task: 'task',
      history: [],
      availableTools: [],
    };

    await expect(service.generate(context, 'task')).rejects.toThrow('LLM unavailable');
  });
});
