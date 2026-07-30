import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../../src/core/memory/index.js';
import { State } from '../../../src/core/types.js';
import type { Mission } from '../../../src/core/agent/types.js';
import type { StateResult } from '../../../src/core/types.js';

/**
 * Store-level test: consumers drive the deepened interface (open → write →
 * index → search) without ever holding a raw db handle.
 */
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'memory-store-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeMission(desc: string): Mission {
  return { id: `task-${Date.now()}`, description: desc, state: 'running' };
}

function makeResult(success: boolean): StateResult {
  return { state: State.DONE, success, output: '', nextState: State.DONE };
}

describe('MemoryStore (deepened interface)', () => {
  it('open() creates a working store for the workspace', () => {
    const store = MemoryStore.open(tmpDir);
    try {
      expect(store.index()).toBe('');
    } finally {
      store.close();
    }
  });

  it('writeEpisodeSync output becomes visible through index() and search()', () => {
    const store = MemoryStore.open(tmpDir);
    try {
      store.writeEpisodeSync(makeMission('fix divide by zero in calc.js'), [], makeResult(true));

      const index = store.index();
      expect(index).toContain('<memory>');
      expect(index).toContain('Recent tasks');

      const hits = store.search('divide by zero');
      expect(hits).toContain('calc.js');
    } finally {
      store.close();
    }
  });

  it('searchById finds an episode by its short id', () => {
    const store = MemoryStore.open(tmpDir);
    try {
      const episodeId = store.writeEpisodeSync(makeMission('explain auth flow'), [], makeResult(true));
      const shortId = episodeId.replace(/-/g, '').slice(0, 4);
      const detail = store.searchById(shortId);
      expect(detail).not.toBeNull();
      expect(detail).toContain('explain auth flow');
      expect(store.searchById('zzzz')).toBeNull();
    } finally {
      store.close();
    }
  });

  it('search reports when nothing matches', () => {
    const store = MemoryStore.open(tmpDir);
    try {
      expect(store.search('nothing-like-this-anywhere')).toContain('No memories found');
    } finally {
      store.close();
    }
  });
});
