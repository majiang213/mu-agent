import { describe, it, expect } from 'vitest';

// Bug 15: FTS5 query injection — keywords with special characters cause SQLite errors.
// We replicate the exact query-building logic from retrieval.ts lines 49-51.

/**
 * Replicate the FTS5 query building logic from retrieval.ts.
 * This is the BROKEN version that only filters " but not other FTS5 special chars.
 */
function buildFtsQuery(keywords: string[]): string {
  return keywords
    .slice(0, 3)
    .map((k) => `"${k.replace(/"/g, '')}"`)
    .join(' OR ');
}

describe('Bug 15: FTS5 query injection from user input', () => {
  it('filters double quotes from keywords', () => {
    // This is the ONLY character currently filtered.
    const query = buildFtsQuery(['hello"world']);
    expect(query).toBe('"helloworld"');
  });

  it('does NOT filter * wildcard character — causes FTS5 syntax error', () => {
    // Bug 15: * is an FTS5 prefix/wildcard operator.
    // "test*" means "match any token starting with test", which may be unintended.
    // In some SQLite versions, bare * causes a syntax error.
    const query = buildFtsQuery(['test*', 'query']);
    // After fix, * should be stripped or escaped.
    // Bug: query contains unescaped * which may cause FTS5 errors.
    expect(query).not.toContain('*');
  });

  it('does NOT filter ^ boost operator', () => {
    // Bug 15: ^ is the FTS5 boost operator.
    const query = buildFtsQuery(['test^2', 'query']);
    expect(query).not.toContain('^');
  });

  it('does NOT filter NEAR() operator', () => {
    // Bug 15: NEAR() is an FTS5 operator that could be injected.
    const query = buildFtsQuery(['NEAR(foo bar)', 'query']);
    // If a user input contains "NEAR(foo bar)", it becomes part of the FTS5 query
    // and may cause unexpected behavior or errors.
    expect(query).not.toMatch(/NEAR\(/);
  });

  it('does NOT filter AND/OR/NOT boolean operators', () => {
    // Bug 15: AND, OR, NOT are FTS5 boolean operators.
    // If a keyword is literally "AND", it becomes a query operator instead of a search term.
    const query = buildFtsQuery(['AND', 'test']);
    // The query becomes: "AND" OR "test" — "AND" in quotes is fine in FTS5,
    // but if the quoting is stripped or the keyword is used without quotes, it's an operator.
    // The current code does quote, so this specific case is actually safe.
    // But keywords like 'NOT test' (with space) would break.
    expect(query).toBeDefined();
  });

  it('handles empty keywords gracefully', () => {
    const query = buildFtsQuery([]);
    expect(query).toBe('');
  });

  it('handles keywords with multiple special characters', () => {
    // Bug 15: A keyword like 'foo*^"bar' has multiple special chars.
    // Only " is stripped; * and ^ remain.
    const query = buildFtsQuery(['foo*^"bar']);
    // After fix, all non-alphanumeric/CJK chars should be stripped.
    expect(query).toMatch(/^"[^*^]+"/);
  });
});
