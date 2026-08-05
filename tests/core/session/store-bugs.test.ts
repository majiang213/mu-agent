import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../src/core/session/store.js';

/**
 * Bug 14 lineage (CRLF tolerance) — Gap 85-B edition: the file format is pi's
 * SessionManager format now, so these tests pin CRLF/mixed-ending tolerance
 * against PI-format files through the SessionStore adapter.
 */
function makeTmpDir(): string {
  const dir = join(tmpdir(), `store-bugs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function piSessionLines(dir: string, contents: string[]): string[] {
  const header = JSON.stringify({
    type: 'session',
    version: 3,
    id: 'test-session',
    timestamp: new Date().toISOString(),
    cwd: dir,
  });
  let parentId: string | null = null;
  const lines = [header];
  contents.forEach((content, i) => {
    const id = `e${i}`;
    lines.push(
      JSON.stringify({
        type: 'message',
        id,
        parentId,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content, timestamp: i + 1 },
      }),
    );
    parentId = id;
  });
  return lines;
}

describe('Bug 14: CRLF line endings (pi session format)', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads a CRLF session file without losing messages', () => {
    const filePath = SessionStore.create(dir).filePath!;
    writeFileSync(filePath, piSessionLines(dir, ['hello', 'world']).join('\r\n') + '\r\n', 'utf-8');

    // open() after the write — create() above only mints the path.
    const store = SessionStore.open(filePath, dir);
    const msgs = store.load();
    expect(msgs).toHaveLength(2);
    expect((msgs[0] as { content: string }).content).toBe('hello');
    expect((msgs[1] as { content: string }).content).toBe('world');
  });

  it('loads mixed LF and CRLF line endings correctly', () => {
    const filePath = SessionStore.create(dir).filePath!;
    const [header, m1, m2] = piSessionLines(dir, ['msg1', 'msg2']);
    writeFileSync(filePath, header + '\n' + m1 + '\r\n' + m2 + '\r\n', 'utf-8');

    expect(SessionStore.open(filePath, dir).load()).toHaveLength(2);
  });

  it('preserves message content that contains \\r characters', () => {
    const filePath = SessionStore.create(dir).filePath!;
    writeFileSync(filePath, piSessionLines(dir, ['line1\rline2']).join('\n') + '\n', 'utf-8');

    const msgs = SessionStore.open(filePath, dir).load();
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as { content: string }).content).toBe('line1\rline2');
  });
});
