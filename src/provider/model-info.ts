const FALLBACK_CONTEXT = 131072;

export interface ModelInfo {
  name: string;
  contextLength: number;
}

export async function fetchOllamaModels(baseUrl: string): Promise<ModelInfo[]> {
  try {
    const url = baseUrl.replace(/\/v1\/?$/, '');
    const res = await fetch(`${url}/api/tags`);
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

async function fetchOllamaContextLength(baseUrl: string, modelName: string): Promise<number> {
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
    });
    if (!res.ok) return FALLBACK_CONTEXT;
    const data = (await res.json()) as {
      model_info?: Record<string, unknown>;
      parameters?: string;
    };
    const ctxFromInfo = data.model_info?.['llama.context_length'];
    if (typeof ctxFromInfo === 'number' && ctxFromInfo > 0) return ctxFromInfo;
    if (typeof data.parameters === 'string') {
      const match = /num_ctx\s+(\d+)/.exec(data.parameters);
      if (match?.[1]) return parseInt(match[1], 10);
    }
    return FALLBACK_CONTEXT;
  } catch {
    return FALLBACK_CONTEXT;
  }
}

export async function fetchCustomModels(baseUrl: string, apiKey?: string): Promise<ModelInfo[]> {
  try {
    const base = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(`${base}/models`, { headers });
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
    const url = baseUrl.replace(/\/v1\/?$/, '');
    return fetchOllamaContextLength(url, modelName);
  }
  try {
    const base = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(`${base}/models/${encodeURIComponent(modelName)}`, { headers });
    if (!res.ok) return FALLBACK_CONTEXT;
    const data = (await res.json()) as { context_window?: number; max_model_len?: number };
    return data.context_window ?? data.max_model_len ?? FALLBACK_CONTEXT;
  } catch {
    return FALLBACK_CONTEXT;
  }
}
