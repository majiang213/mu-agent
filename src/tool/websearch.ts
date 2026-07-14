import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchDuckDuckGo(query: string, numResults: number): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query);
  const url = `https://api.duckduckgo.com/?q=${encoded}&format=json&no_redirect=1`;

  const response = await fetch(url, {
    headers: { 'User-Agent': 'mu-agent/1.0 (coding assistant)' },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo API error: HTTP ${response.status}`);
  }

  const data = (await response.json()) as DuckDuckGoResponse;
  const results: SearchResult[] = [];

  if (data.AbstractText && data.AbstractURL) {
    results.push({
      title: data.Heading ?? query,
      url: data.AbstractURL,
      snippet: data.AbstractText,
    });
  }

  for (const topic of data.RelatedTopics ?? []) {
    if (results.length >= numResults) break;
    if ('Topics' in topic) {
      for (const sub of topic.Topics ?? []) {
        if (results.length >= numResults) break;
        if (sub.FirstURL && sub.Text) {
          results.push({ title: sub.Text.slice(0, 80), url: sub.FirstURL, snippet: sub.Text });
        }
      }
    } else if (topic.FirstURL && topic.Text) {
      results.push({ title: topic.Text.slice(0, 80), url: topic.FirstURL, snippet: topic.Text });
    }
  }

  return results.slice(0, numResults);
}

interface DuckDuckGoTopic {
  FirstURL?: string;
  Text?: string;
  Topics?: DuckDuckGoTopic[];
}

interface DuckDuckGoResponse {
  Heading?: string;
  AbstractText?: string;
  AbstractURL?: string;
  RelatedTopics?: DuckDuckGoTopic[];
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No results found.';
  }
  return results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`).join('\n\n');
}

const _websearchParams = Type.Object({
  query: Type.String({ description: 'The search query.' }),
  numResults: Type.Optional(Type.Number({ description: 'Number of results to return (default: 5, max: 10).' })),
});

export const websearchTool: AgentTool<typeof _websearchParams, SearchResult[]> = {
  name: 'websearch',
  label: 'Web Search',
  description:
    'Search the web using DuckDuckGo. Returns a list of results with titles, URLs, and snippets. Use this to find documentation, answers to errors, or current information.',
  parameters: _websearchParams,
  execute: async (_toolCallId, params) => {
    const numResults = Math.min(params.numResults ?? 5, 10);
    let text: string;
    let results: SearchResult[] = [];
    try {
      results = await searchDuckDuckGo(params.query, numResults);
      text = `Search results for: "${params.query}"\n\n${formatResults(results)}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      text = `Search failed for "${params.query}": ${msg}`;
    }
    return {
      content: [{ type: 'text' as const, text }],
      details: results,
    };
  },
};
