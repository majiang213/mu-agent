import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';

const MAX_CONTENT_LENGTH = 32000;

async function fetchUrl(url: string, format: 'markdown' | 'text' | 'html'): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'mu-agent/1.0 (coding assistant)' },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const raw = await response.text();

  if (format === 'html') return raw;
  if (format === 'text') return stripHtml(raw);

  if (contentType.includes('text/html')) {
    return htmlToMarkdown(raw, url);
  }
  return raw;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function htmlToMarkdown(html: string, baseUrl: string): string {
  let md = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n#### $1\n')
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const absHref = href.startsWith('http') ? href : new URL(href, baseUrl).href;
      return `[${text}](${absHref})`;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return md;
}

function truncate(content: string, maxLen: number): { text: string; truncated: boolean } {
  if (content.length <= maxLen) return { text: content, truncated: false };
  return {
    text: content.slice(0, maxLen) + `\n\n[Content truncated at ${maxLen} chars. Total: ${content.length} chars]`,
    truncated: true,
  };
}

const _webfetchParams = Type.Object({
  url: Type.String({ description: 'The URL to fetch. Must be a fully-formed valid URL.' }),
  format: Type.Optional(
    Type.Union([Type.Literal('markdown'), Type.Literal('text'), Type.Literal('html')], {
      description:
        'Output format. "markdown" (default) converts HTML to readable markdown. "text" strips all tags. "html" returns raw HTML.',
    }),
  ),
});
type WebfetchParams = Static<typeof _webfetchParams>;

export const webfetchTool: AgentTool<typeof _webfetchParams, { url: string; truncated: boolean }> = {
  name: 'webfetch',
  label: 'Web Fetch',
  description:
    'Fetches content from a URL and returns it in the specified format (markdown by default). Use this to read documentation, articles, or any web page.',
  parameters: _webfetchParams,
  execute: async (_toolCallId, params: WebfetchParams) => {
    const format = params.format ?? 'markdown';
    let text: string;
    try {
      const raw = await fetchUrl(params.url, format);
      const result = truncate(raw, MAX_CONTENT_LENGTH);
      text = result.text;
      return {
        content: [{ type: 'text' as const, text }],
        details: { url: params.url, truncated: result.truncated },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      text = `Error fetching ${params.url}: ${msg}`;
      return {
        content: [{ type: 'text' as const, text }],
        details: { url: params.url, truncated: false },
      };
    }
  },
};
