import { NodeHtmlMarkdown } from 'node-html-markdown';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';

const MAX_CONTENT_LENGTH = 32000;

function validateUrl(urlString: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}. Only http: and https: are allowed.`);
  }
  const hostname = parsed.hostname;
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    /^10\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname)
  ) {
    throw new Error(`Refusing to fetch private/local address: ${hostname}`);
  }
  return parsed;
}

async function fetchUrl(url: string, format: 'markdown' | 'text' | 'html'): Promise<string> {
  validateUrl(url);
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

function htmlToMarkdown(html: string, _baseUrl: string): string {
  return NodeHtmlMarkdown.translate(html);
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
