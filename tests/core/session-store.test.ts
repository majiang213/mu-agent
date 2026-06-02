import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../src/core/session/store.js';

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

    it('filePath ends with .json', () => {
      const store = SessionStore.create(dir);
      expect(store.filePath).toMatch(/\.json$/);
    });

    it('filePath is inside .mu-agent/sessions/', () => {
      const store = SessionStore.create(dir);
      expect(store.filePath).toContain(join('.mu-agent', 'sessions'));
    });
  });

  describe('append', () => {
    it('writes header on first append', () => {
      const store = SessionStore.create(dir);
      store.append({ type: 'message', role: 'user', content: 'hello', timestamp: Date.now() });
      const lines = readFileSync(store.filePath, 'utf-8').trim().split('\n');
      const header = JSON.parse(lines[0]!);
      expect(header.type).toBe('header');
      expect(header.cwd).toBe(dir);
    });

    it('appends message after header', () => {
      const store = SessionStore.create(dir);
      const ts = Date.now();
      store.append({ type: 'message', role: 'user', content: 'test msg', timestamp: ts });
      const lines = readFileSync(store.filePath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      const msg = JSON.parse(lines[1]!);
      expect(msg.type).toBe('message');
      expect(msg.content).toBe('test msg');
    });

    it('isEmpty becomes false after first append', () => {
      const store = SessionStore.create(dir);
      expect(store.isEmpty).toBe(true);
      store.append({ type: 'message', role: 'user', content: 'x', timestamp: Date.now() });
      expect(store.isEmpty).toBe(false);
    });

    it('appends multiple messages sequentially', () => {
      const store = SessionStore.create(dir);
      store.append({ type: 'message', role: 'user', content: 'msg1', timestamp: 1 });
      store.append({ type: 'message', role: 'user', content: 'msg2', timestamp: 2 });
      store.append({ type: 'message', role: 'user', content: 'msg3', timestamp: 3 });
      const lines = readFileSync(store.filePath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(4);
    });
  });

  describe('load', () => {
    it('returns empty array for new empty store', () => {
      const store = SessionStore.create(dir);
      expect(store.load()).toEqual([]);
    });

    it('loads messages as AgentMessage array', () => {
      const store = SessionStore.create(dir);
      store.append({ type: 'message', role: 'user', content: 'hello', timestamp: 123 });
      store.append({ type: 'message', role: 'user', content: 'world', timestamp: 456 });
      const msgs = store.load();
      expect(msgs).toHaveLength(2);
      expect(msgs[0]!.role).toBe('user');
      expect((msgs[0] as { content: string }).content).toBe('hello');
      expect((msgs[1] as { content: string }).content).toBe('world');
    });

    it('does not include header in loaded messages', () => {
      const store = SessionStore.create(dir);
      store.append({ type: 'message', role: 'user', content: 'msg', timestamp: 1 });
      const msgs = store.load();
      for (const m of msgs) {
        expect((m as { type?: string }).type).not.toBe('header');
      }
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

    it('opens the most recent session by mtime', async () => {
      const sessionsDir = join(dir, '.mu-agent', 'sessions');
      mkdirSync(sessionsDir, { recursive: true });

      const { writeFileSync } = await import('node:fs');
      const { join: pathJoin } = await import('node:path');

      const older = pathJoin(sessionsDir, '2026-01-01T00-00-00Z.json');
      const newer = pathJoin(sessionsDir, '2026-01-02T00-00-00Z.json');

      const header = JSON.stringify({ type: 'header', cwd: dir, created: 1 });
      writeFileSync(
        older,
        header + '\n' + JSON.stringify({ type: 'message', role: 'user', content: 'first', timestamp: 1 }) + '\n',
      );
      await new Promise((r) => setTimeout(r, 50));
      writeFileSync(
        newer,
        header + '\n' + JSON.stringify({ type: 'message', role: 'user', content: 'second', timestamp: 2 }) + '\n',
      );

      const latest = SessionStore.openLatest(dir);
      expect(latest).not.toBeNull();
      const msgs = latest!.load();
      expect((msgs[0] as { content: string }).content).toBe('second');
    });

    it('opened store has isEmpty=false', () => {
      const s = SessionStore.create(dir);
      s.append({ type: 'message', role: 'user', content: 'x', timestamp: 1 });
      const opened = SessionStore.openLatest(dir);
      expect(opened?.isEmpty).toBe(false);
    });
  });

  describe('open', () => {
    it('opens a specific session by filePath', () => {
      const s = SessionStore.create(dir);
      s.append({ type: 'message', role: 'user', content: 'specific', timestamp: 1 });
      const opened = SessionStore.open(s.filePath, dir);
      const msgs = opened.load();
      expect((msgs[0] as { content: string }).content).toBe('specific');
    });
  });

  describe('list', () => {
    it('returns empty array when no sessions exist', () => {
      expect(SessionStore.list(dir)).toEqual([]);
    });

    it('returns session infos sorted newest first', async () => {
      const sessionsDir = join(dir, '.mu-agent', 'sessions');
      mkdirSync(sessionsDir, { recursive: true });

      const { writeFileSync } = await import('node:fs');
      const { join: pathJoin } = await import('node:path');

      const header = JSON.stringify({ type: 'header', cwd: dir, created: 1 });
      const older = pathJoin(sessionsDir, '2026-01-01T00-00-00Z.json');
      const newer = pathJoin(sessionsDir, '2026-01-02T00-00-00Z.json');

      writeFileSync(
        older,
        header + '\n' + JSON.stringify({ type: 'message', role: 'user', content: 'old session', timestamp: 1 }) + '\n',
      );
      await new Promise((r) => setTimeout(r, 50));
      writeFileSync(
        newer,
        header + '\n' + JSON.stringify({ type: 'message', role: 'user', content: 'new session', timestamp: 2 }) + '\n',
      );

      const list = SessionStore.list(dir);
      expect(list.length).toBe(2);
      expect(list[0]!.preview).toContain('new session');
    });

    it('preview shows first non-assistant message up to 50 chars', () => {
      const s = SessionStore.create(dir);
      s.append({ type: 'message', role: 'user', content: 'fix the login bug in auth module', timestamp: 1 });
      const list = SessionStore.list(dir);
      expect(list[0]!.preview).toBe('fix the login bug in auth module');
    });

    it('preview excludes [Assistant]: prefixed messages', () => {
      const s = SessionStore.create(dir);
      s.append({ type: 'message', role: 'user', content: '[Assistant]: done', timestamp: 1 });
      s.append({ type: 'message', role: 'user', content: 'real user msg', timestamp: 2 });
      const list = SessionStore.list(dir);
      expect(list[0]!.preview).toBe('real user msg');
    });

    it('each info has filePath, created, preview fields', () => {
      const s = SessionStore.create(dir);
      s.append({ type: 'message', role: 'user', content: 'hello', timestamp: 1 });
      const list = SessionStore.list(dir);
      expect(typeof list[0]!.filePath).toBe('string');
      expect(typeof list[0]!.created).toBe('number');
      expect(typeof list[0]!.preview).toBe('string');
    });
  });
});
