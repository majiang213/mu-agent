import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildProjectTree } from '../../../src/core/graph/tree.js';

// Bug 19 (tree.ts:61): files filter doesn't exclude dotfiles, .env content may leak into LLM context.
// Bug 19 (tree.ts:81): slice(0, MAX_CHARS) truncates file names, producing invalid paths.

describe('Bug 19: tree.ts dotfile and truncation issues', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `tree-bugs-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('buildProjectTree excludes dotfiles like .env from the tree', () => {
    // Arrange: create a .env file with secrets.
    writeFileSync(join(testDir, '.env'), 'API_KEY=secret123', 'utf-8');
    writeFileSync(join(testDir, 'src'), '', 'utf-8'); // dummy non-dotfile

    // Bug 19 (tree.ts:61): The files filter is:
    //   entries.filter((e) => !IGNORE_DIRS.has(e) && isFile(join(dir, e)))
    // It does NOT filter out entries starting with '.'.
    // The dirs filter DOES exclude dotfiles: !e.startsWith('.')
    // But the files filter doesn't, so .env appears in the tree.
    // If .env appears in the tree and the agent reads it, secrets leak into LLM context.
    const tree = buildProjectTree(testDir);

    // After fix: dotfiles should be excluded from the files list.
    expect(tree).not.toContain('.env');
  });

  it('buildProjectTree does not produce truncated file names', () => {
    // Bug 19 (tree.ts:81): The final slice is:
    //   result.length > MAX_CHARS ? result.slice(0, MAX_CHARS) + '\n...' : result
    // This slices the string at a character boundary, which may cut a file name in half.
    // E.g., "very-long-filename.ts" could become "very-long-filen" — an invalid path.

    // Create enough files to exceed MAX_CHARS (3000)
    mkdirSync(join(testDir, 'src'), { recursive: true });
    for (let i = 0; i < 100; i++) {
      writeFileSync(join(testDir, `src/file-with-very-long-name-${i.toString().padStart(3, '0')}.ts`), '', 'utf-8');
    }

    const tree = buildProjectTree(testDir);

    // If truncated, the last line before '...' should be a complete file name.
    if (tree.includes('...')) {
      const lines = tree.split('\n');
      const truncationIndex = lines.findIndex((l) => l.includes('...'));
      if (truncationIndex > 0) {
        const lastFileLine = lines[truncationIndex - 1]!;
        // The line should not be cut mid-character.
        // After fix, truncation should happen at a line boundary.
        expect(lastFileLine.trim()).not.toMatch(/\.\.\.$/); // shouldn't already end with ...
        // The file name should be complete (not cut in half)
        expect(lastFileLine.trim()).toMatch(/\.\w+$/); // should end with a file extension
      }
    }
  });
});
