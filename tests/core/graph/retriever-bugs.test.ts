import { describe, it, expect } from 'vitest';

// Bug 19 (graph/retriever.ts:32-168): Each retrieve() opens/closes 3-4 DB connections.
// Bug 19 (graph/retriever.ts:187): Empty BM25 index cached for 5 minutes after 0 results.

describe('Bug 19: GraphRetriever excessive DB connections', () => {
  it('retrieve() reuses a single DB connection instead of opening multiple', () => {
    // Bug 19 (retriever.ts:32-168): hasGraph() opens+closes a DB connection.
    // Then ensureBM25() opens+closes another.
    // Then expandGraph() opens+closes another.
    // Then fetchNodes() opens+closes another.
    // Total: 4 DB connections per retrieve() call.
    // In parallel LOCATE steps, this can exhaust file descriptors.

    // We verify by checking the source code structure.
    const fs = require('node:fs');
    const path = require('node:path');
    const sourcePath = path.join(process.cwd(), 'src/core/graph/retriever.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Count occurrences of `new Database(` in the retriever class
    const newDbMatches = source.match(/new Database\(/g);
    const dbOpenCount = newDbMatches?.length ?? 0;

    // Bug 19: There are 4 separate `new Database()` calls (hasGraph, ensureBM25, expandGraph, fetchNodes).
    // After fix, should use a single shared connection or connection pool.
    // Ideally <= 2 (one for the class, or passed as dependency).
    expect(dbOpenCount).toBeLessThanOrEqual(2);
  });
});

describe('Bug 19: BM25 index caches empty result for 5 minutes', () => {
  it('does not cache empty BM25 index when no nodes exist', () => {
    // Bug 19 (retriever.ts:187): ensureBM25() catches errors and sets:
    //   this.bm25Index = new Map();  // empty map
    //   this.bm25BuiltAt = Date.now();
    // This caches the empty result for 5 minutes (300_000ms).
    // If nodes are added during that window, retrieve() still returns empty.

    // We verify by checking the source code.
    const fs = require('node:fs');
    const path = require('node:path');
    const sourcePath = path.join(process.cwd(), 'src/core/graph/retriever.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Find the catch block in ensureBM25
    const ensureBM25Match = source.match(/private ensureBM25[\s\S]*?(?=^\s*private|^\s*\}$)/m);
    expect(ensureBM25Match).not.toBeNull();

    const body = ensureBM25Match![0];

    // Bug 19: The catch block sets bm25Index = new Map() AND bm25BuiltAt = Date.now().
    // After fix, the catch should NOT set bm25BuiltAt, or should use a shorter TTL
    // for empty results.
    // Check that the catch block doesn't set bm25BuiltAt when index is empty.
    const catchMatch = body.match(/catch[\s\S]*?bm25BuiltAt/);
    // Bug: this pattern matches because catch sets bm25BuiltAt.
    // After fix, bm25BuiltAt should not be set when bm25Index is empty.
    expect(catchMatch).toBeNull();
  });
});
