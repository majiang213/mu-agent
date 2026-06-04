import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../src/core/session/store.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `store-bugs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('Bug 14: CRLF line endings cause JSON.parse failure', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads session file with CRLF line endings without losing messages', () => {
    // Arrange: create a session file with CRLF line endings (as Windows would write).
    const store = SessionStore.create(dir);
    const header = JSON.stringify({ type: 'header', cwd: dir, created: Date.now(), version: 1 });
    const msg1 = JSON.stringify({ type: 'message', role: 'user', content: 'hello', timestamp: 1 });
    const msg2 = JSON.stringify({ type: 'message', role: 'user', content: 'world', timestamp: 2 });

    // Write with CRLF (\r\n) line endings — simulates Windows environment
    const crlfContent = [header, msg1, msg2].join('\r\n') + '\r\n';
    writeFileSync(store.filePath, crlfContent, 'utf-8');

    // Act: load the session
    const msgs = store.load();

    // Bug 14: split('\n') on CRLF content leaves trailing \r on each line.
    // JSON.parse('{"type":"message",...}\r') throws, and the catch silently
    // discards the line. Result: ALL messages are lost.
    // After fix: should use split(/\r?\n/) or .replace(/\r/g, '') before parsing.
    expect(msgs).toHaveLength(2);
    expect((msgs[0] as { content: string }).content).toBe('hello');
    expect((msgs[1] as { content: string }).content).toBe('world');
  });

  it('loads mixed LF and CRLF line endings correctly', () => {
    const store = SessionStore.create(dir);
    const header = JSON.stringify({ type: 'header', cwd: dir, created: Date.now(), version: 1 });
    const msg1 = JSON.stringify({ type: 'message', role: 'user', content: 'msg1', timestamp: 1 });
    const msg2 = JSON.stringify({ type: 'message', role: 'user', content: 'msg2', timestamp: 2 });

    // Mix: header uses LF, messages use CRLF
    const mixedContent = header + '\n' + msg1 + '\r\n' + msg2 + '\r\n';
    writeFileSync(store.filePath, mixedContent, 'utf-8');

    const msgs = store.load();

    // Bug 14: msg1 and msg2 have trailing \r, causing JSON.parse to fail.
    expect(msgs).toHaveLength(2);
  });

  it('preserves message content that contains \\r characters', () => {
    const store = SessionStore.create(dir);
    const header = JSON.stringify({ type: 'header', cwd: dir, created: Date.now(), version: 1 });
    // Content that legitimately contains \r
    const msg = JSON.stringify({ type: 'message', role: 'user', content: 'line1\rline2', timestamp: 1 });

    const content = header + '\n' + msg + '\n';
    writeFileSync(store.filePath, content, 'utf-8');

    const msgs = store.load();

    expect(msgs).toHaveLength(1);
    // The \r inside the JSON string value should be preserved.
    expect((msgs[0] as { content: string }).content).toBe('line1\rline2');
  });
});
