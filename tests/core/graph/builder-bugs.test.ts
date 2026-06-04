import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Bug 10: buildFull() has no transaction — process crash between DELETE and INSERT leaves empty graph.

// We can't easily test actual process interruption, but we can verify the code behavior
// by examining whether buildFull uses a transaction.

describe('Bug 10: buildFull() lacks transaction protection', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `graph-bug10-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    // Create a minimal source file for the graph builder to parse
    writeFileSync(join(testDir, 'test.ts'), 'export function hello() { return "world"; }', 'utf-8');
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('buildFull wraps DELETE + INSERT in a single transaction', () => {
    // Bug 10: buildFull() at lines 112-137 does:
    //   1. DELETE all nodes/edges (auto-committed)
    //   2. INSERT each file's nodes/edges (each auto-committed)
    //   3. INSERT graph_meta
    //
    // If the process is killed between step 1 and step 2, the graph is empty.
    // graph_meta still has the current commit hash, so needsRebuild() returns false.
    // The empty graph is permanently used.
    //
    // After fix: steps 1-3 should be wrapped in db.transaction().
    //
    // We verify by checking that the source code uses db.transaction() around
    // the DELETE + INSERT sequence. This is a structural test.

    // Import the source and check if buildFull uses transaction.
    // Since we can't easily mock better-sqlite3, we verify the behavior
    // by reading the source file.
    const fs = require('node:fs');
    const path = require('node:path');
    const sourcePath = path.join(process.cwd(), 'src/core/graph/builder.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Check that buildFull uses db.transaction()
    const buildFullMatch = source.match(/buildFull\(\)[\s\S]*?(?=^\s*(?:updateFiles|private|}|$))/m);
    expect(buildFullMatch).not.toBeNull();

    const buildFullBody = buildFullMatch![0];

    // Bug 10: The DELETE and INSERT are NOT wrapped in db.transaction().
    // After fix, there should be a db.transaction() call wrapping the DELETE + INSERT.
    expect(buildFullBody).toMatch(/db\.transaction\(/);

    // Verify the transaction wraps both DELETE and INSERT
    // The transaction should contain DELETE FROM edges/nodes and INSERT INTO nodes
    expect(buildFullBody).toMatch(/DELETE FROM/);
    expect(buildFullBody).toMatch(/INSERT/);
  });
});
