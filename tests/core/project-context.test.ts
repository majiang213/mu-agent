import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadContext } from '../../src/core/agent/context.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ctx-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Gap 86: loadContext is pi loadProjectContextFiles underneath — global
 * agentDir file + ancestor walk (per-dir first match of AGENTS.md/CLAUDE.md),
 * with .mu-agent/context.md appended last. Tests always pass an isolated
 * agentDir so the developer's real ~/.mu-agent cannot pollute results.
 */
describe('loadContext', () => {
  let dir: string;
  let agentDir: string;

  beforeEach(() => {
    dir = makeTmpDir();
    agentDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  describe('file not found', () => {
    it('returns null when no context file exists', () => {
      expect(loadContext(dir, agentDir)).toBeNull();
    });
  });

  describe('per-directory first match: AGENTS.md > CLAUDE.md', () => {
    it('returns AGENTS.md when only AGENTS.md exists', () => {
      writeFileSync(join(dir, 'AGENTS.md'), '# agents content');
      const ctx = loadContext(dir, agentDir);
      expect(ctx?.source).toBe('AGENTS.md');
      expect(ctx?.content).toBe('# agents content');
    });

    it('returns CLAUDE.md when only CLAUDE.md exists', () => {
      writeFileSync(join(dir, 'CLAUDE.md'), '# claude content');
      const ctx = loadContext(dir, agentDir);
      expect(ctx?.source).toBe('CLAUDE.md');
      expect(ctx?.content).toBe('# claude content');
    });

    it('prefers AGENTS.md over CLAUDE.md within one directory', () => {
      writeFileSync(join(dir, 'AGENTS.md'), '# agents');
      writeFileSync(join(dir, 'CLAUDE.md'), '# claude');
      const ctx = loadContext(dir, agentDir);
      expect(ctx?.source).toBe('AGENTS.md');
      expect(ctx?.content).toBe('# agents');
    });
  });

  describe('ancestor merge (pi semantics)', () => {
    it('merges parent AGENTS.md with child CLAUDE.md, parent first', () => {
      const child = join(dir, 'sub', 'proj');
      mkdirSync(child, { recursive: true });
      writeFileSync(join(dir, 'AGENTS.md'), '# root agents');
      writeFileSync(join(child, 'CLAUDE.md'), '# child claude');
      const ctx = loadContext(child, agentDir);
      expect(ctx?.content).toBe('# root agents\n\n# child claude');
      expect(ctx?.source).toContain('CLAUDE.md');
    });

    it('includes global agentDir context file first', () => {
      writeFileSync(join(agentDir, 'AGENTS.md'), '# global');
      writeFileSync(join(dir, 'AGENTS.md'), '# project');
      const ctx = loadContext(dir, agentDir);
      expect(ctx?.content).toBe('# global\n\n# project');
    });
  });

  describe('.mu-agent/context.md appended last', () => {
    it('returns context.md when only that exists', () => {
      mkdirSync(join(dir, '.mu-agent'), { recursive: true });
      writeFileSync(join(dir, '.mu-agent', 'context.md'), '# context content');
      const ctx = loadContext(dir, agentDir);
      expect(ctx?.source).toBe(join('.mu-agent', 'context.md'));
      expect(ctx?.content).toBe('# context content');
    });

    it('appends context.md after AGENTS.md', () => {
      writeFileSync(join(dir, 'AGENTS.md'), '# agents');
      mkdirSync(join(dir, '.mu-agent'), { recursive: true });
      writeFileSync(join(dir, '.mu-agent', 'context.md'), '# context');
      const ctx = loadContext(dir, agentDir);
      expect(ctx?.content).toBe('# agents\n\n# context');
      expect(ctx?.source).toBe(`AGENTS.md, ${join('.mu-agent', 'context.md')}`);
    });
  });

  describe('full content injection (no truncation)', () => {
    it('returns full content regardless of length', () => {
      const longContent = 'x'.repeat(10000);
      writeFileSync(join(dir, 'AGENTS.md'), longContent);
      const ctx = loadContext(dir, agentDir);
      expect(ctx?.content.length).toBe(10000);
      expect(ctx?.content).toBe(longContent);
    });

    it('does not add truncation markers', () => {
      const longContent = 'line\n'.repeat(500);
      writeFileSync(join(dir, 'AGENTS.md'), longContent);
      const ctx = loadContext(dir, agentDir);
      expect(ctx?.content).not.toContain('[...truncated]');
      expect(ctx?.content).not.toContain('truncated');
    });
  });

  describe('interface shape', () => {
    it('returned object has content and source fields only', () => {
      writeFileSync(join(dir, 'AGENTS.md'), 'hello');
      const ctx = loadContext(dir, agentDir);
      expect(ctx).not.toBeNull();
      expect(typeof ctx?.content).toBe('string');
      expect(typeof ctx?.source).toBe('string');
      expect('truncated' in (ctx ?? {})).toBe(false);
    });

    it('content matches file exactly', () => {
      const content = '# Project\n\n- Use npm test\n- TypeScript 5\n';
      writeFileSync(join(dir, 'AGENTS.md'), content);
      const ctx = loadContext(dir, agentDir);
      expect(ctx?.content).toBe(content);
    });
  });
});
