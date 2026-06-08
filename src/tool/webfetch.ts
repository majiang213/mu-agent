import { NodeHtmlMarkdown } from 'node-html-markdown';
import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';

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
  // Strip IPv6 brackets for comparison
  const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (
    bare === 'localhost' ||
    bare === '127.0.0.1' ||
    bare === '::1' ||
    bare === '0.0.0.0' ||
    // IPv4-mapped IPv6: ::ffff:127.0.0.1 or ::ffff:7f00:1
    /^::ffff:/i.test(bare) ||
    /^10\./.test(bare) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(bare) ||
    /^192\.168\./.test(bare) ||
    /^169\.254\./.test(bare)
  ) {
    throw new Error('Refusing to fetch private/local address');
  }
  return parsed;
}

async function fetchUrl(url: string, format: 'markdown' | 'text' | 'html'): Promise<string> {
  validateUrl(url);
  const response = await fetch(url, {
    headers: { 'User-Agent': 'mu-agent/1.0 (coding assistant)' },
    signal: AbortSignal.timeout(15000),
    redirect: 'manual',
  });

  // Validate redirect target before following
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) throw new Error(`Redirect with no location header`);
    validateUrl(location);
    const redirectResponse = await fetch(location, {
      headers: { 'User-Agent': 'mu-agent/1.0 (coding assistant)' },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    if (!redirectResponse.ok) {
      throw new Error(`HTTP ${redirectResponse.status}`);
    }
    const contentType = redirectResponse.headers.get('content-type') ?? '';
    const raw = await redirectResponse.text();
    if (format === 'html') return raw;
    if (format === 'text') return stripHtml(raw);
    if (contentType.includes('text/html')) return htmlToMarkdown(raw, location);
    return raw;
  }

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const webfetchTool: AgentTool<any, { url: string; truncated: boolean }> = {
  name: 'webfetch',
  label: 'Web Fetch',
  description:
    'Fetches content from a URL and returns it in the specified format (markdown by default). Use this to read documentation, articles, or any web page.',
  parameters: _webfetchParams,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (_toolCallId, params: any) => {
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
      // Sanitize error message — avoid leaking internal IPs or OS details
      const raw = err instanceof Error ? err.message : String(err);
      const msg = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/.test(raw)
        ? 'Network error: unable to reach the server'
        : raw.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]').replace(/:\d{2,5}\b/g, ':[port]');
      text = `Error fetching ${params.url}: ${msg}`;
      return {
        content: [{ type: 'text' as const, text }],
        details: { url: params.url, truncated: false },
      };
    }
  },
};
