import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { buildModels, getSharedModelRuntime, resetSharedModelRuntime } from '../../src/provider/model-info.js';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSharedModelRuntime();
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/show')) {
      return Promise.resolve(jsonResponse({ model_info: { 'llama.context_length': 8192 } }));
    }
    if (url.includes('/api/tags')) {
      return Promise.resolve(jsonResponse({ models: [{ name: 'm1:latest' }, { name: 'm2:latest' }] }));
    }
    return Promise.resolve(jsonResponse({}, false));
  });
});

describe('buildModels → ModelRuntime (Gap 85-C)', () => {
  it('registers the configured provider into the shared runtime', async () => {
    const { runtime } = await buildModels('m1:latest', 'ollama', 'http://localhost:11434', 0.5);
    expect(runtime.getRegisteredProviderIds()).toContain('ollama');
    const entry = runtime.getModel('ollama', 'm1:latest');
    expect(entry).toBeDefined();
    expect(entry!.contextWindow).toBe(8192);
    expect(entry!.maxTokens).toBe(Math.floor(8192 * 0.5));
  });

  it('runtime is the process-wide singleton shared with the idle TUI selector', async () => {
    const { runtime } = await buildModels('m1:latest', 'ollama', 'http://localhost:11434', 0.5);
    expect(await getSharedModelRuntime()).toBe(runtime);
  });

  it('a second buildModels re-registers on the SAME runtime (no per-run rebuild)', async () => {
    const first = await buildModels('m1:latest', 'ollama', 'http://localhost:11434', 0.5);
    const second = await buildModels('m2:latest', 'ollama', 'http://localhost:11434', 0.5);
    expect(second.runtime).toBe(first.runtime);
  });

  it('resetSharedModelRuntime drops the singleton (test seam)', async () => {
    const a = await getSharedModelRuntime();
    resetSharedModelRuntime();
    const b = await getSharedModelRuntime();
    expect(b).not.toBe(a);
  });

  it('refreshModels lists the live server catalog for the selector', async () => {
    const { runtime } = await buildModels('m1:latest', 'ollama', 'http://localhost:11434', 0.5);
    const registered = runtime.getRegisteredProviderConfig('ollama');
    expect(registered?.refreshModels).toBeDefined();
    const live = await registered!.refreshModels!({} as never);
    const ids = live!.map((m) => m.id);
    expect(ids).toContain('m1:latest');
    expect(ids).toContain('m2:latest');
    // Live sibling carries the probed context length from /api/show
    const sibling = live!.find((m) => m.id === 'm2:latest');
    expect(sibling!.contextWindow).toBe(8192);
    expect(sibling!.maxTokens).toBe(Math.floor(8192 * 0.5));
  });
});
