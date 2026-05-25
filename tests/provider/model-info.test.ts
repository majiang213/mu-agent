import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('fetchOllamaModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when fetch fails', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    const { fetchOllamaModels } = await import('../../src/provider/model-info.js');
    expect(await fetchOllamaModels('http://localhost:11434')).toEqual([]);
  });

  it('returns empty array when response is not ok', async () => {
    mockFetch.mockResolvedValue(makeResponse({}, false));
    const { fetchOllamaModels } = await import('../../src/provider/model-info.js');
    expect(await fetchOllamaModels('http://localhost:11434')).toEqual([]);
  });

  it('returns empty array when no models in response', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ models: [] }));
    const { fetchOllamaModels } = await import('../../src/provider/model-info.js');
    expect(await fetchOllamaModels('http://localhost:11434')).toEqual([]);
  });

  it('strips /v1 suffix from baseUrl before calling /api/tags', async () => {
    mockFetch.mockResolvedValue(makeResponse({ models: [] }));
    const { fetchOllamaModels } = await import('../../src/provider/model-info.js');
    await fetchOllamaModels('http://localhost:11434/v1');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:11434/api/tags');
  });

  it('returns models with context length from model_info', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse({ models: [{ name: 'llama3:8b' }] }))
      .mockResolvedValueOnce(makeResponse({ model_info: { 'llama.context_length': 8192 } }));
    const { fetchOllamaModels } = await import('../../src/provider/model-info.js');
    const models = await fetchOllamaModels('http://localhost:11434');
    expect(models).toEqual([{ name: 'llama3:8b', contextLength: 8192 }]);
  });

  it('falls back to num_ctx in parameters when model_info missing', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse({ models: [{ name: 'qwen:7b' }] }))
      .mockResolvedValueOnce(makeResponse({ parameters: 'num_ctx 32768\ntemperature 0.1' }));
    const { fetchOllamaModels } = await import('../../src/provider/model-info.js');
    const models = await fetchOllamaModels('http://localhost:11434');
    expect(models[0].contextLength).toBe(32768);
  });

  it('uses fallback 131072 when context cannot be determined', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse({ models: [{ name: 'unknown' }] }))
      .mockResolvedValueOnce(makeResponse({}));
    const { fetchOllamaModels } = await import('../../src/provider/model-info.js');
    const models = await fetchOllamaModels('http://localhost:11434');
    expect(models[0].contextLength).toBe(131072);
  });
});

describe('fetchCustomModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when fetch fails', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    const { fetchCustomModels } = await import('../../src/provider/model-info.js');
    expect(await fetchCustomModels('http://custom:8080')).toEqual([]);
  });

  it('returns empty array when response is not ok', async () => {
    mockFetch.mockResolvedValue(makeResponse({}, false));
    const { fetchCustomModels } = await import('../../src/provider/model-info.js');
    expect(await fetchCustomModels('http://custom:8080')).toEqual([]);
  });

  it('appends /v1 when not already present', async () => {
    mockFetch.mockResolvedValue(makeResponse({ data: [] }));
    const { fetchCustomModels } = await import('../../src/provider/model-info.js');
    await fetchCustomModels('http://custom:8080');
    expect(mockFetch).toHaveBeenCalledWith('http://custom:8080/v1/models', expect.any(Object));
  });

  it('does not double-append /v1', async () => {
    mockFetch.mockResolvedValue(makeResponse({ data: [] }));
    const { fetchCustomModels } = await import('../../src/provider/model-info.js');
    await fetchCustomModels('http://custom:8080/v1');
    expect(mockFetch).toHaveBeenCalledWith('http://custom:8080/v1/models', expect.any(Object));
  });

  it('returns models with context_window', async () => {
    mockFetch.mockResolvedValue(makeResponse({ data: [{ id: 'gpt-4o', context_window: 128000 }] }));
    const { fetchCustomModels } = await import('../../src/provider/model-info.js');
    const models = await fetchCustomModels('http://custom:8080');
    expect(models).toEqual([{ name: 'gpt-4o', contextLength: 128000 }]);
  });

  it('falls back to max_model_len when context_window missing', async () => {
    mockFetch.mockResolvedValue(makeResponse({ data: [{ id: 'vllm-model', max_model_len: 4096 }] }));
    const { fetchCustomModels } = await import('../../src/provider/model-info.js');
    const models = await fetchCustomModels('http://custom:8080');
    expect(models[0].contextLength).toBe(4096);
  });

  it('uses fallback 131072 when no context field present', async () => {
    mockFetch.mockResolvedValue(makeResponse({ data: [{ id: 'unknown-model' }] }));
    const { fetchCustomModels } = await import('../../src/provider/model-info.js');
    const models = await fetchCustomModels('http://custom:8080');
    expect(models[0].contextLength).toBe(131072);
  });

  it('sends Authorization header when apiKey provided', async () => {
    mockFetch.mockResolvedValue(makeResponse({ data: [] }));
    const { fetchCustomModels } = await import('../../src/provider/model-info.js');
    await fetchCustomModels('http://custom:8080', 'sk-secret');
    const callArgs = mockFetch.mock.calls[0][1] as RequestInit;
    expect((callArgs.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-secret');
  });
});

describe('fetchContextLength', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses ollama /api/show for ollama provider', async () => {
    mockFetch.mockResolvedValue(makeResponse({ model_info: { 'llama.context_length': 16384 } }));
    const { fetchContextLength } = await import('../../src/provider/model-info.js');
    const ctx = await fetchContextLength('ollama', 'http://localhost:11434', 'llama3:8b');
    expect(ctx).toBe(16384);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/show',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('uses /v1/models/{id} for custom provider', async () => {
    mockFetch.mockResolvedValue(makeResponse({ context_window: 8192 }));
    const { fetchContextLength } = await import('../../src/provider/model-info.js');
    const ctx = await fetchContextLength('custom', 'http://custom:8080', 'my-model');
    expect(ctx).toBe(8192);
    expect(mockFetch).toHaveBeenCalledWith('http://custom:8080/v1/models/my-model', expect.any(Object));
  });

  it('returns fallback 131072 when fetch fails', async () => {
    mockFetch.mockRejectedValue(new Error('timeout'));
    const { fetchContextLength } = await import('../../src/provider/model-info.js');
    const ctx = await fetchContextLength('ollama', 'http://localhost:11434', 'llama3:8b');
    expect(ctx).toBe(131072);
  });

  it('returns fallback when response is not ok', async () => {
    mockFetch.mockResolvedValue(makeResponse({}, false));
    const { fetchContextLength } = await import('../../src/provider/model-info.js');
    const ctx = await fetchContextLength('custom', 'http://custom:8080', 'my-model');
    expect(ctx).toBe(131072);
  });
});
