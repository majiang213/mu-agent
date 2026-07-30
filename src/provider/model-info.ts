const FALLBACK_CONTEXT = 131072;

/**
 * pi-ai's openai-completions API requires an apiKey string; Ollama ignores
 * it, so this dummy value is used. The ONE place that knows the sentinel —
 * previously re-declared as a bare 'ollama' literal in four modules
 * (second-pass review, candidate 9).
 */
export const OLLAMA_DUMMY_API_KEY = 'ollama';

/**
 * Resolve the apiKey for a model config: the configured key, the dummy
 * sentinel for Ollama, or '' (non-Ollama without a key — the upstream call
 * will fail auth and surface the real configuration error).
 */
export function resolveApiKey(model: { provider: string; apiKey?: string }): string {
  return model.apiKey ?? (model.provider === 'ollama' ? OLLAMA_DUMMY_API_KEY : '');
}

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/v1$/, '');
}

export interface ModelInfo {
  name: string;
  contextLength: number;
}

export async function fetchOllamaModels(baseUrl: string): Promise<ModelInfo[]> {
  try {
    const url = normalizeBase(baseUrl);
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('json')) {
      console.warn('[model-info] Unexpected content-type from /api/tags:', ct);
      return [];
    }
    const data = (await res.json()) as { models?: { name: string }[] };
    const models = data.models ?? [];
    const infos = await Promise.all(
      models.map(async (m): Promise<ModelInfo> => {
        const ctx = await fetchOllamaContextLength(url, m.name);
        return { name: m.name, contextLength: ctx };
      }),
    );
    return infos;
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      console.warn('[model-info] Request timed out (5s)');
    } else if (err instanceof Error) {
      console.warn('[model-info] Request failed:', err.message);
    }
    return [];
  }
}

interface OllamaShowResponse {
  model_info?: Record<string, unknown>;
  parameters?: string;
}

async function fetchOllamaShow(baseUrl: string, modelName: string): Promise<OllamaShowResponse | null> {
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as OllamaShowResponse;
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      console.warn('[model-info] Request timed out (5s)');
    } else if (err instanceof Error) {
      console.warn('[model-info] Request failed:', err.message);
    }
    return null;
  }
}

async function fetchOllamaContextLength(baseUrl: string, modelName: string): Promise<number> {
  const data = await fetchOllamaShow(baseUrl, modelName);
  if (!data) return FALLBACK_CONTEXT;
  const ctxFromInfo = data.model_info?.['llama.context_length'];
  if (typeof ctxFromInfo === 'number' && ctxFromInfo > 0) return ctxFromInfo;
  if (typeof data.parameters === 'string') {
    const match = /num_ctx\s+(\d+)/.exec(data.parameters);
    if (match?.[1]) return parseInt(match[1], 10);
  }
  return FALLBACK_CONTEXT;
}

export async function fetchOllamaParamCount(baseUrl: string, modelName: string): Promise<number | null> {
  const url = normalizeBase(baseUrl);
  const data = await fetchOllamaShow(url, modelName);
  if (!data) return null;
  const paramCount = data.model_info?.['general.parameter_count'];
  if (typeof paramCount === 'number' && paramCount > 0) return paramCount;
  return null;
}

export async function fetchOpenAICompatModels(baseUrl: string, apiKey?: string): Promise<ModelInfo[]> {
  try {
    const base = `${normalizeBase(baseUrl)}/v1`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { id: string; context_window?: number; max_model_len?: number }[] };
    return (data.data ?? []).map((m) => ({
      name: m.id,
      contextLength: m.context_window ?? m.max_model_len ?? FALLBACK_CONTEXT,
    }));
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      console.warn('[model-info] Request timed out (5s)');
    } else if (err instanceof Error) {
      console.warn('[model-info] Request failed:', err.message);
    }
    return [];
  }
}

async function fetchOpenAICompatContextLength(baseUrl: string, modelName: string, apiKey?: string): Promise<number> {
  try {
    const base = `${normalizeBase(baseUrl)}/v1`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(`${base}/models/${encodeURIComponent(modelName)}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return FALLBACK_CONTEXT;
    const data = (await res.json()) as { context_window?: number; max_model_len?: number };
    return data.context_window ?? data.max_model_len ?? FALLBACK_CONTEXT;
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      console.warn('[model-info] Request timed out (5s)');
    } else if (err instanceof Error) {
      console.warn('[model-info] Request failed:', err.message);
    }
    return FALLBACK_CONTEXT;
  }
}

export async function fetchContextLength(
  provider: string,
  baseUrl: string,
  modelName: string,
  apiKey?: string,
): Promise<number> {
  if (provider === 'ollama') {
    const url = normalizeBase(baseUrl);
    return fetchOllamaContextLength(url, modelName);
  }
  if (provider === 'unsloth') {
    return fetchOpenAICompatContextLength(baseUrl, modelName, apiKey);
  }
  return fetchOpenAICompatContextLength(baseUrl, modelName, apiKey);
}
