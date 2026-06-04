import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeResponse(body: unknown, ok = true, contentType = 'application/json'): Response {
  return {
    ok,
    headers: { get: (name: string) => (name === 'content-type' ? contentType : null) },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('Bug 16: baseUrl trailing slash causes double /v1 path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetchCustomModels does not produce //v1 when baseUrl ends with /v1/', async () => {
    // Arrange: baseUrl has trailing slash after /v1
    mockFetch.mockResolvedValue(makeResponse({ data: [] }));

    const { fetchCustomModels } = await import('../../src/provider/model-info.js');
    await fetchCustomModels('http://host:8080/v1/');

    // Bug 16: normalizeBase uses /v1/?$/ regex replacement.
    // With baseUrl = 'http://host:8080/v1/', normalizeBase strips the trailing slash
    // to get 'http://host:8080/v1', then fetchCustomModels appends '/v1/models',
    // producing 'http://host:8080/v1/v1/models' — a double path.
    // After fix: normalizeBase should strip the /v1 suffix entirely, or the function
    // should handle trailing slashes properly.
    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).not.toContain('//v1');
    expect(calledUrl).not.toContain('/v1/v1');
  });

  it('fetchOllamaModels handles baseUrl with trailing slash', async () => {
    mockFetch.mockResolvedValue(makeResponse({ models: [] }));

    const { fetchOllamaModels } = await import('../../src/provider/model-info.js');
    await fetchOllamaModels('http://localhost:11434/');

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    // Should call /api/tags, not //api/tags
    expect(calledUrl).toContain('/api/tags');
    expect(calledUrl).not.toContain('//api/tags');
  });

  it('fetchContextLength handles baseUrl ending with /v1/', async () => {
    mockFetch.mockResolvedValue(makeResponse({ context_window: 8192 }));

    const { fetchContextLength } = await import('../../src/provider/model-info.js');
    await fetchContextLength('custom', 'http://host:8080/v1/', 'model');

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    // Should be http://host:8080/v1/models/model, not http://host:8080/v1//v1/models/model
    expect(calledUrl).toBe('http://host:8080/v1/models/model');
  });

  it('fetchOllamaParamCount handles baseUrl with trailing slash', async () => {
    mockFetch.mockResolvedValue(makeResponse({ model_info: { 'general.parameter_count': 7e9 } }));

    const { fetchOllamaParamCount } = await import('../../src/provider/model-info.js');
    await fetchOllamaParamCount('http://localhost:11434/', 'model');

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/api/show');
    expect(calledUrl).not.toContain('//api/show');
  });
});
