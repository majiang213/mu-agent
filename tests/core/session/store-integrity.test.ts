import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../src/core/session/store.js';

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

  it('writes .jsonl files and reads legacy .json files back', async () => {
    const store = SessionStore.create(dir);
    expect(store.filePath.endsWith('.jsonl')).toBe(true);
    await store.append({ type: 'message', role: 'user', content: 'new format', timestamp: 1 });

    // A legacy .json session must still be discoverable.
    const legacy = join(dir, '.mu-agent', 'sessions', '2000-01-01T00-00-00Z_legacy.json');
    writeFileSync(
      legacy,
      JSON.stringify({ type: 'header', cwd: dir, created: 1, version: 1 }) +
        '\n' +
        JSON.stringify({ type: 'message', role: 'user', content: 'legacy', timestamp: 1 }) +
        '\n',
      'utf-8',
    );

    const sessions = SessionStore.list(dir);
    expect(sessions).toHaveLength(2);
    expect(sessions.some((s) => s.filePath.endsWith('.json'))).toBe(true);
    expect(sessions.some((s) => s.preview === 'new format')).toBe(true);
  });

  it('list() and openLatest() do NOT create the sessions directory (reads stay read-only)', () => {
    expect(SessionStore.list(dir)).toEqual([]);
    expect(SessionStore.openLatest(dir)).toBeNull();
    expect(existsSync(join(dir, '.mu-agent', 'sessions'))).toBe(false);
  });

  it('orders by filename timestamp, not mtime', async () => {
    const sessionsDir = join(dir, '.mu-agent', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const older = join(sessionsDir, '2020-01-01T00-00-00Z_aaaa.jsonl');
    const newer = join(sessionsDir, '2026-01-01T00-00-00Z_bbbb.jsonl');
    for (const [file, content] of [
      [older, 'older-by-name'],
      [newer, 'newer-by-name'],
    ] as const) {
      writeFileSync(
        file,
        JSON.stringify({ type: 'header', cwd: dir, created: 1, version: 1 }) +
          '\n' +
          JSON.stringify({ type: 'message', role: 'user', content, timestamp: 1 }) +
          '\n',
        'utf-8',
      );
    }
    // Inflate the OLD file's mtime beyond the new one — name order must still win.
    const future = new Date(Date.now() + 60_000);
    utimesSync(older, future, future);

    const latest = SessionStore.openLatest(dir);
    expect(latest?.filePath).toBe(newer);
  });

  it('preview is the first USER message, even with prefixed assistant content present', async () => {
    const store = SessionStore.create(dir);
    await store.append({ type: 'message', role: 'assistant', content: '[Assistant]: noise', timestamp: 1 });
    await store.append({ type: 'message', role: 'user', content: 'the real question', timestamp: 2 });

    const sessions = SessionStore.list(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.preview).toBe('the real question');
  });

  it('a failed append does not poison later appends (and the caller still sees the failure)', async () => {
    const store = SessionStore.create(dir);
    const sessionsDir = join(dir, '.mu-agent', 'sessions');

    // First append succeeds (creates the file).
    await store.append({ type: 'message', role: 'user', content: 'first', timestamp: 1 });

    // Make the next append fail: remove the sessions directory entirely.
    rmSync(sessionsDir, { recursive: true, force: true });
    await expect(store.append({ type: 'message', role: 'user', content: 'doomed', timestamp: 2 })).rejects.toThrow();

    // Recover the directory — the queue must NOT be poisoned.
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(store.filePath, JSON.stringify({ type: 'header', cwd: dir, created: 1, version: 1 }) + '\n', 'utf-8');
    await expect(
      store.append({ type: 'message', role: 'user', content: 'recovered', timestamp: 3 }),
    ).resolves.toBeUndefined();

    const msgs = store.load();
    expect(msgs.some((m) => (m as { content: string }).content === 'recovered')).toBe(true);
  });
});
