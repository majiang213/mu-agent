import { describe, it, expect } from 'vitest';
import { createWebfetchTool, type FetchLike } from '../../src/tool/webfetch.js';
import { createWebsearchTool } from '../../src/tool/websearch.js';

/**
 * These tests cross the fetch seam with canned responses — the previous
 * versions asserted on source text and even tested Node's URL builtin.
 */

function fakeResponse(init: {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
}): Response {
  const { status = 200, statusText = 'OK', headers = {}, body = '' } = init;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

async function toolText(
  tool: { execute: (id: string, params: never) => Promise<{ content: Array<{ type: string; text?: string }> }> },
  params: unknown,
): Promise<string> {
  const r = await tool.execute('id', params as never);
  return r.content.flatMap((c) => (c.type === 'text' && c.text ? [c.text] : [])).join('');
}

describe('webfetch through the fetch seam', () => {
  it('fetches and converts HTML to markdown', async () => {
    const fetchImpl: FetchLike = async () =>
      fakeResponse({ headers: { 'content-type': 'text/html' }, body: '<h1>Hello</h1><p>World</p>' });
    const tool = createWebfetchTool(fetchImpl);
    const text = await toolText(tool, { url: 'https://example.com', format: 'markdown' });
    expect(text).toContain('Hello');
  });

  it('blocks private/local addresses without calling fetch', async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return fakeResponse({});
    };
    const tool = createWebfetchTool(fetchImpl);
    const text = await toolText(tool, { url: 'http://192.168.1.1/admin' });
    expect(called).toBe(false);
    expect(text).toContain('Error fetching');
    expect(text).toContain('private/local');
  });

  it('revalidates redirect targets (SSRF via redirect)', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(String(url));
      return fakeResponse({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    };
    const tool = createWebfetchTool(fetchImpl);
    const text = await toolText(tool, { url: 'https://example.com/redirect' });
    // The redirect target is private — never followed.
    expect(calls).toHaveLength(1);
    expect(text).toContain('Error fetching');
  });

  it('sanitizes network errors', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('fetch failed: ECONNREFUSED 10.0.0.5:8080');
    };
    const tool = createWebfetchTool(fetchImpl);
    const text = await toolText(tool, { url: 'https://example.com' });
    expect(text).toContain('Network error: unable to reach the server');
    expect(text).not.toContain('10.0.0.5');
  });
});

describe('websearch through the fetch seam', () => {
  it('formats abstract and related topics', async () => {
    const fetchImpl: FetchLike = async () =>
      fakeResponse({
        body: JSON.stringify({
          Heading: 'TypeScript',
          AbstractText: 'A typed superset of JavaScript.',
          AbstractURL: 'https://example.com/ts',
          RelatedTopics: [{ FirstURL: 'https://example.com/generics', Text: 'Generics in TypeScript' }],
        }),
      });
    const tool = createWebsearchTool(fetchImpl);
    const text = await toolText(tool, { query: 'typescript' });
    expect(text).toContain('A typed superset of JavaScript.');
    expect(text).toContain('Generics in TypeScript');
  });

  it('returns a failure message on HTTP errors (success channel)', async () => {
    const fetchImpl: FetchLike = async () => fakeResponse({ status: 500, statusText: 'Server Error' });
    const tool = createWebsearchTool(fetchImpl);
    const text = await toolText(tool, { query: 'x' });
    expect(text).toContain('Search failed');
    expect(text).toContain('500');
  });

  it('says when no results were found', async () => {
    const fetchImpl: FetchLike = async () => fakeResponse({ body: JSON.stringify({}) });
    const tool = createWebsearchTool(fetchImpl);
    const text = await toolText(tool, { query: 'obscure-nothing' });
    expect(text).toContain('No results found.');
  });
});
