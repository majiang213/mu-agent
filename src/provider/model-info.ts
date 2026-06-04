const FALLBACK_CONTEXT = 131072;

function normalizeBase(url: string): string {
  return url.replace(/\/v1\/?$/, '');
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
    const data = (await res.json()) as { models?: { name: string }[] };
    const models = data.models ?? [];
    const infos = await Promise.all(
      models.map(async (m): Promise<ModelInfo> => {
        const ctx = await fetchOllamaContextLength(url, m.name);
        return { name: m.name, contextLength: ctx };
      }),
    );
    return infos;
  } catch {
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
  } catch {
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

export async function fetchCustomModels(baseUrl: string, apiKey?: string): Promise<ModelInfo[]> {
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
  } catch {
    return [];
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
  } catch {
    return FALLBACK_CONTEXT;
  }
}
