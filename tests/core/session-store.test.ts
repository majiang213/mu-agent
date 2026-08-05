import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../src/core/session/store.js';

/**
 * Gap 85-B: SessionStore is now a thin adapter over pi's SessionManager.
 * These tests pin the ADAPTER contract (create/openLatest/open/list/append/
 * load/isEmpty/filePath), not the file format — the format is pi's.
 */
function makeTmpDir(): string {
  const dir = join(tmpdir(), `ss-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('SessionStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('creates sessions directory automatically', () => {
      SessionStore.create(dir);
      expect(existsSync(join(dir, '.mu-agent', 'sessions'))).toBe(true);
    });

    it('returns a store with isEmpty=true before first append', () => {
      const store = SessionStore.create(dir);
      expect(store.isEmpty).toBe(true);
    });

    it('filePath ends with .jsonl and is inside .mu-agent/sessions/', () => {
      const store = SessionStore.create(dir);
      expect(store.filePath).toMatch(/\.jsonl$/);
      expect(store.filePath!).toContain(join('.mu-agent', 'sessions'));
    });
  });

  describe('append', () => {
    it('persists the file once an assistant message arrives (pi defers user-only sessions)', async () => {
      const store = SessionStore.create(dir);
      await store.append({ type: 'message', role: 'user', content: 'hello', timestamp: Date.now() });
      // pi design: user-only sessions never hit disk (abandoned prompts stay ephemeral)
      expect(existsSync(store.filePath!)).toBe(false);
      await store.append({ type: 'message', role: 'assistant', content: 'hi', timestamp: Date.now() });
      const lines = readFileSync(store.filePath!, 'utf-8').trim().split('\n');
      const header = JSON.parse(lines[0]!);
      expect(header.type).toBe('session');
      expect(header.cwd).toBe(dir);
    });

    it('isEmpty becomes false after first append', async () => {
      const store = SessionStore.create(dir);
      expect(store.isEmpty).toBe(true);
      await store.append({ type: 'message', role: 'user', content: 'x', timestamp: Date.now() });
      expect(store.isEmpty).toBe(false);
    });

    it('appends multiple messages in order', async () => {
      const store = SessionStore.create(dir);
      await store.append({ type: 'message', role: 'user', content: 'msg1', timestamp: 1 });
      await store.append({ type: 'message', role: 'user', content: 'msg2', timestamp: 2 });
      await store.append({ type: 'message', role: 'user', content: 'msg3', timestamp: 3 });
      const msgs = store.load();
      expect(msgs.map((m) => (m as { content: string }).content)).toEqual(['msg1', 'msg2', 'msg3']);
    });
  });

  describe('load', () => {
    it('returns empty array for new empty store', () => {
      const store = SessionStore.create(dir);
      expect(store.load()).toEqual([]);
    });

    it('roundtrips user + assistant messages with roles and content', async () => {
      const store = SessionStore.create(dir);
      await store.append({ type: 'message', role: 'user', content: 'hello', timestamp: 123 });
      await store.append({ type: 'message', role: 'assistant', content: 'world', timestamp: 456 });
      const msgs = store.load();
      expect(msgs).toHaveLength(2);
      expect(msgs[0]!.role).toBe('user');
      expect((msgs[0] as { content: string }).content).toBe('hello');
      expect(msgs[1]!.role).toBe('assistant');
      expect((msgs[1] as { content: string }).content).toBe('world');
    });
  });

  describe('openLatest', () => {
    it('returns null when no sessions exist', () => {
      expect(SessionStore.openLatest(dir)).toBeNull();
    });

    it('returns null when sessions dir is empty', () => {
      mkdirSync(join(dir, '.mu-agent', 'sessions'), { recursive: true });
      expect(SessionStore.openLatest(dir)).toBeNull();
    });

    it('opens the most recent session', async () => {
      const older = SessionStore.create(dir);
      await older.append({ type: 'message', role: 'user', content: 'first', timestamp: 1 });
      await older.append({ type: 'message', role: 'assistant', content: 'reply1', timestamp: 2 });
      await new Promise((r) => setTimeout(r, 20));
      const newer = SessionStore.create(dir);
      await newer.append({ type: 'message', role: 'user', content: 'second', timestamp: 3 });
      await newer.append({ type: 'message', role: 'assistant', content: 'reply2', timestamp: 4 });

      const latest = SessionStore.openLatest(dir);
      expect(latest).not.toBeNull();
      const msgs = latest!.load();
      expect((msgs[0] as { content: string }).content).toBe('second');
    });

    it('opened store has isEmpty=false', async () => {
      const s = SessionStore.create(dir);
      await s.append({ type: 'message', role: 'user', content: 'x', timestamp: 1 });
      await s.append({ type: 'message', role: 'assistant', content: 'y', timestamp: 2 });
      const opened = SessionStore.openLatest(dir);
      expect(opened?.isEmpty).toBe(false);
    });
  });

  describe('open', () => {
    it('opens a specific session by filePath', async () => {
      const s = SessionStore.create(dir);
      await s.append({ type: 'message', role: 'user', content: 'specific', timestamp: 1 });
      await s.append({ type: 'message', role: 'assistant', content: 'answer', timestamp: 2 });
      const opened = SessionStore.open(s.filePath!, dir);
      const msgs = opened.load();
      expect((msgs[0] as { content: string }).content).toBe('specific');
    });
  });

  describe('list', () => {
    it('returns empty array when no sessions exist', async () => {
      expect(await SessionStore.list(dir)).toEqual([]);
    });

    it('returns session infos newest first', async () => {
      const older = SessionStore.create(dir);
      await older.append({ type: 'message', role: 'user', content: 'old session', timestamp: 1 });
      await older.append({ type: 'message', role: 'assistant', content: 'r1', timestamp: 2 });
      await new Promise((r) => setTimeout(r, 20));
      const newer = SessionStore.create(dir);
      await newer.append({ type: 'message', role: 'user', content: 'new session', timestamp: 3 });
      await newer.append({ type: 'message', role: 'assistant', content: 'r2', timestamp: 4 });

      const list = await SessionStore.list(dir);
      expect(list.length).toBe(2);
      expect(list[0]!.preview).toContain('new session');
    });

    it('preview is the first USER message (assistant messages skipped)', async () => {
      const s = SessionStore.create(dir);
      await s.append({ type: 'message', role: 'assistant', content: 'unprefixed assistant text', timestamp: 1 });
      await s.append({ type: 'message', role: 'user', content: 'real user msg', timestamp: 2 });
      await s.append({ type: 'message', role: 'assistant', content: 'more', timestamp: 3 });
      const list = await SessionStore.list(dir);
      expect(list[0]!.preview).toBe('real user msg');
    });

    it('each info has filePath, created, preview fields', async () => {
      const s = SessionStore.create(dir);
      await s.append({ type: 'message', role: 'user', content: 'hello', timestamp: 1 });
      await s.append({ type: 'message', role: 'assistant', content: 'hi', timestamp: 2 });
      const list = await SessionStore.list(dir);
      expect(typeof list[0]!.filePath).toBe('string');
      expect(typeof list[0]!.created).toBe('number');
      expect(typeof list[0]!.preview).toBe('string');
    });
  });

  describe('legacy mu-agent files are retired, not migrated (Gap 85-B)', () => {
    it('old-format .jsonl (header type "header") is invisible to list + openLatest', async () => {
      const sessionsDir = join(dir, '.mu-agent', 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(
        join(sessionsDir, '2026-01-01T00-00-00Z_old.jsonl'),
        JSON.stringify({ type: 'header', cwd: dir, created: 1, version: 1 }) +
          '\n' +
          JSON.stringify({ type: 'message', role: 'user', content: 'legacy msg', timestamp: 1 }) +
          '\n',
      );

      expect(await SessionStore.list(dir)).toEqual([]);
      expect(SessionStore.openLatest(dir)).toBeNull();
    });

    it('legacy .json files are invisible too', async () => {
      const sessionsDir = join(dir, '.mu-agent', 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(
        join(sessionsDir, '2026-01-01T00-00-00Z.json'),
        JSON.stringify({ type: 'header', cwd: dir, created: 1 }) + '\n',
      );
      expect(await SessionStore.list(dir)).toEqual([]);
      expect(SessionStore.openLatest(dir)).toBeNull();
    });
  });
});
