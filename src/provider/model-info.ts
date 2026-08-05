import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Model, Models } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { MU_AGENT_DIR } from '../config/defaults.js';
import { DEFAULT_CONTEXT_RATIO } from '../config/defaults.js';

const FALLBACK_CONTEXT = 131072;
// Sibling-catalog entries whose source gave no context length get this
// conservative default — deliberately smaller than FALLBACK_CONTEXT (the
// current-model probe fallback): overestimating a sibling's window would
// silently misinform the selector.
const SIBLING_CONTEXT_FALLBACK = 32768;

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
  // unsloth and custom providers share the OpenAI-compatible probe (the
  // separate unsloth arm was a dead duplicate — round-5 hygiene nit).
  return fetchOpenAICompatContextLength(baseUrl, modelName, apiKey);
}

/** Live model list for the selector's refreshModels — ollama /api/tags or the OpenAI-compat /v1/models probe. */
async function fetchProviderModels(provider: string, baseUrl: string, apiKey?: string): Promise<ModelInfo[]> {
  if (provider === 'ollama') return fetchOllamaModels(baseUrl);
  return fetchOpenAICompatModels(baseUrl, apiKey);
}

/**
 * Assemble the pi-ai Model + Models collection for a run (Gap 89 → 85-C):
 * context length probed dynamically, maxTokens derived from contextRatio.
 * Provider facts live in this module — buildModel moved here from
 * step-runner.ts, where it was a stowaway whose only caller is RunSetup
 * (round-4 hygiene).
 *
 * Gap 85-C: the Models collection is pi-coding-agent's ModelRuntime (modelsPath
 * null — config.json stays the single source of truth, no models.json).
 * The configured provider registers as an extension provider whose apiKey may
 * use pi's `$ENV_VAR` interpolation (resolved inside the runtime's auth path).
 * `refreshModels` lists the server's live models (Ollama /api/tags etc.) so
 * the TUI model selector offers what actually exists.
 */
export interface BuiltModel {
  models: Models;
  model: Model<'openai-completions'>;
  runtime: ModelRuntime;
}

/**
 * Process-wide runtime (Gap 85-C): the per-run model build AND the idle-time
 * TUI model selector must see the same provider registry, so the runtime is a
 * singleton created here. It contains no per-model facts (context window lives
 * on the per-run Model entry), so a model switch needs no runtime rebuild.
 */
let sharedRuntime: ModelRuntime | null = null;

export async function getSharedModelRuntime(): Promise<ModelRuntime> {
  if (!sharedRuntime) {
    sharedRuntime = await ModelRuntime.create({
      // config.json 单真相源（Gap 85-C 决策）— no models.json, credentials to mu-agent dir
      modelsPath: null,
      authPath: join(homedir(), MU_AGENT_DIR, 'auth.json'),
      allowModelNetwork: false,
    });
  }
  return sharedRuntime;
}

/** Test seam: drop the singleton so a test can rebuild with fresh config. */
export function resetSharedModelRuntime(): void {
  sharedRuntime = null;
}

/**
 * Build + register the configured model. Takes the model slice of Config
 * (structurally — tests pass literals): the contextRatio default derivation
 * lives HERE now, not at both call sites (round-8, candidate 8).
 */
export async function buildModels(modelCfg: {
  name: string;
  provider: string;
  baseUrl: string;
  contextRatio?: number;
  apiKey?: string;
}): Promise<BuiltModel> {
  const { name: modelName, provider, baseUrl, apiKey } = modelCfg;
  const contextRatio = modelCfg.contextRatio ?? DEFAULT_CONTEXT_RATIO;
  const apiBase = `${normalizeBase(baseUrl)}/v1`; // normalizeBase strips trailing slashes + any existing /v1
  const contextWindow = await fetchContextLength(provider, baseUrl, modelName, apiKey);
  const model: Model<'openai-completions'> = {
    id: modelName,
    name: modelName,
    api: 'openai-completions',
    provider,
    baseUrl: apiBase,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.floor(contextWindow * (1 - contextRatio)),
  };
  const runtime = await getSharedModelRuntime();
  runtime.registerProvider(provider, {
    name: provider,
    baseUrl: apiBase,
    // May be '$ENV_VAR' — the runtime resolves interpolation in its auth path
    // (Gap 85-C: apiKey resolution aligned to pi, resolveApiKey kept only for
    // the compaction generateSummary path).
    ...(apiKey ? { apiKey } : {}),
    api: 'openai-completions',
    models: [
      {
        id: model.id,
        name: model.name,
        reasoning: false,
        input: ['text'],
        cost: model.cost,
        contextWindow,
        maxTokens: model.maxTokens,
      },
    ],
    refreshModels: async () => {
      const live = await fetchProviderModels(provider, baseUrl, apiKey);
      return live.map((m) => {
        const isCurrent = m.name === model.id;
        return {
          id: m.name,
          name: m.name,
          reasoning: false,
          input: ['text' as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          // Live siblings carry their probed context length when the fetcher
          // provides one (ollama does), a conservative default otherwise.
          contextWindow: isCurrent ? contextWindow : (m.contextLength ?? SIBLING_CONTEXT_FALLBACK),
          maxTokens: isCurrent
            ? model.maxTokens
            : Math.floor((m.contextLength ?? SIBLING_CONTEXT_FALLBACK) * (1 - contextRatio)),
        };
      });
    },
  });
  return { models: runtime, model, runtime };
}
