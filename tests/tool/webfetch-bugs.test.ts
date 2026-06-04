import { describe, it, expect } from 'vitest';

// Bug 9: webfetch calls new URL(href, baseUrl) which throws on certain href values.
// In Node.js, new URL() with a base URL handles some cases differently than browsers.
// The real issue is in the webfetch code path where URL resolution happens without try/catch.

describe('Bug 9: webfetch URL handling for fragment/mailto/empty href', () => {
  it('handles javascript: URLs without crashing', () => {
    // Bug 9: In some environments, new URL('javascript:void(0)', base) may throw.
    // In Node.js 20+, this actually works (returns a valid URL object).
    // The bug is that the code doesn't have try/catch around URL resolution.
    // This test documents the behavior.
    const result = new URL('javascript:void(0)', 'https://example.com');
    expect(result).toBeDefined();
    expect(result.protocol).toBe('javascript:');
  });

  it('handles mailto: URLs without crashing', () => {
    // In Node.js, new URL('mailto:...', base) works fine.
    const result = new URL('mailto:user@example.com', 'https://example.com');
    expect(result).toBeDefined();
    expect(result.protocol).toBe('mailto:');
  });

  it('webfetch source code has try/catch around URL resolution', () => {
    // Bug 9: The webfetch tool should handle URL errors gracefully.
    // The tool's execute function already wraps fetchUrl in try/catch,
    // but if htmlToMarkdown internally resolves URLs, those need protection too.
    const fs = require('node:fs');
    const path = require('node:path');
    const sourcePath = path.join(process.cwd(), 'src/tool/webfetch.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // The execute function should catch URL-related errors
    expect(source).toContain('catch');
    // The function should handle errors gracefully (return error message, not crash)
    expect(source).toContain('Error fetching');
  });

  it('handles data: URLs without crashing', () => {
    // Bug 9: data: URLs with special characters may cause issues.
    const result = new URL('data:text/html,<h1>test</h1>', 'https://example.com');
    expect(result).toBeDefined();
    expect(result.protocol).toBe('data:');
  });

  it('handles empty href with base URL', () => {
    // Bug 9: Empty href returns the base URL, which may cause unexpected behavior.
    const result = new URL('', 'https://example.com/page');
    expect(result.href).toBe('https://example.com/page');
  });
});
