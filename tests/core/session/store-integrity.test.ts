import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../src/core/session/store.js';

/**
 * Gap 85-B integrity contract — pi SessionManager edition. Format-level
 * parsing (CRLF, malformed lines, migrations) is pi's own tested surface;
 * these tests pin only what mu-agent's adapter still guarantees.
 */
function makeTmpDir(): string {
  const dir = join(tmpdir(), `store-integrity-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('SessionStore integrity', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('list() and openLatest() do NOT create the sessions directory (reads stay read-only)', async () => {
    expect(await SessionStore.list(dir)).toEqual([]);
    expect(SessionStore.openLatest(dir)).toBeNull();
    expect(existsSync(join(dir, '.mu-agent', 'sessions'))).toBe(false);
  });

  it('a failed append surfaces to the caller and does not poison later appends', async () => {
    const store = SessionStore.create(dir);
    const sessionsDir = join(dir, '.mu-agent', 'sessions');

    // Persist the file (pi writes once an assistant message exists).
    await store.append({ type: 'message', role: 'user', content: 'first', timestamp: 1 });
    await store.append({ type: 'message', role: 'assistant', content: 'a1', timestamp: 2 });

    // Make the next append fail: remove the sessions directory entirely.
    rmSync(sessionsDir, { recursive: true, force: true });
    // pi writes synchronously — the failure throws out of append() directly.
    expect(() => store.append({ type: 'message', role: 'user', content: 'doomed', timestamp: 3 })).toThrow();

    // Recover the directory — appends work again (no poisoned write queue;
    // pi has no queue, each append is its own synchronous write).
    mkdirSync(sessionsDir, { recursive: true });
    await expect(
      store.append({ type: 'message', role: 'user', content: 'recovered', timestamp: 4 }),
    ).resolves.toBeUndefined();

    const msgs = store.load();
    expect(msgs.some((m) => (m as { content: string }).content === 'recovered')).toBe(true);
  });

  it('concurrent appends all land in order (pi writes synchronously, no queue needed)', async () => {
    const store = SessionStore.create(dir);
    await store.append({ type: 'message', role: 'assistant', content: 'seed', timestamp: 0 });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.append({ type: 'message', role: 'user', content: `m${i}`, timestamp: i + 1 }),
      ),
    );
    const msgs = store.load();
    const contents = msgs.map((m) => (m as { content: string }).content);
    for (let i = 0; i < 10; i++) {
      expect(contents).toContain(`m${i}`);
    }
    expect(contents.indexOf('m0')).toBeLessThan(contents.indexOf('m9'));
  });
});
