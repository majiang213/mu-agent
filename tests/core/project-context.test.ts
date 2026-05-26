import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadProjectContext } from '../../src/core/project-context.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ctx-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('loadProjectContext', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('file not found', () => {
    it('returns null when no context file exists', () => {
      expect(loadProjectContext(dir)).toBeNull();
    });
  });

  describe('priority order: AGENTS.md > CLAUDE.md > .local-agent/context.md', () => {
    it('returns AGENTS.md when only AGENTS.md exists', () => {
      writeFileSync(join(dir, 'AGENTS.md'), '# agents content');
      const ctx = loadProjectContext(dir);
      expect(ctx?.source).toBe('AGENTS.md');
      expect(ctx?.content).toBe('# agents content');
    });

    it('returns CLAUDE.md when only CLAUDE.md exists', () => {
      writeFileSync(join(dir, 'CLAUDE.md'), '# claude content');
      const ctx = loadProjectContext(dir);
      expect(ctx?.source).toBe('CLAUDE.md');
      expect(ctx?.content).toBe('# claude content');
    });

    it('returns .local-agent/context.md when only that exists', () => {
      mkdirSync(join(dir, '.local-agent'), { recursive: true });
      writeFileSync(join(dir, '.local-agent', 'context.md'), '# context content');
      const ctx = loadProjectContext(dir);
      expect(ctx?.source).toBe('.local-agent/context.md');
      expect(ctx?.content).toBe('# context content');
    });

    it('prefers AGENTS.md over CLAUDE.md when both exist', () => {
      writeFileSync(join(dir, 'AGENTS.md'), '# agents');
      writeFileSync(join(dir, 'CLAUDE.md'), '# claude');
      const ctx = loadProjectContext(dir);
      expect(ctx?.source).toBe('AGENTS.md');
      expect(ctx?.content).toBe('# agents');
    });

    it('prefers CLAUDE.md over .local-agent/context.md when AGENTS.md absent', () => {
      writeFileSync(join(dir, 'CLAUDE.md'), '# claude');
      mkdirSync(join(dir, '.local-agent'), { recursive: true });
      writeFileSync(join(dir, '.local-agent', 'context.md'), '# context');
      const ctx = loadProjectContext(dir);
      expect(ctx?.source).toBe('CLAUDE.md');
    });

    it('prefers AGENTS.md over all others when all three exist', () => {
      writeFileSync(join(dir, 'AGENTS.md'), '# agents');
      writeFileSync(join(dir, 'CLAUDE.md'), '# claude');
      mkdirSync(join(dir, '.local-agent'), { recursive: true });
      writeFileSync(join(dir, '.local-agent', 'context.md'), '# context');
      const ctx = loadProjectContext(dir);
      expect(ctx?.source).toBe('AGENTS.md');
    });
  });

  describe('full content injection (no truncation)', () => {
    it('returns full content regardless of length', () => {
      const longContent = 'x'.repeat(10000);
      writeFileSync(join(dir, 'AGENTS.md'), longContent);
      const ctx = loadProjectContext(dir);
      expect(ctx?.content.length).toBe(10000);
      expect(ctx?.content).toBe(longContent);
    });

    it('does not add truncation markers', () => {
      const longContent = 'line\n'.repeat(500);
      writeFileSync(join(dir, 'AGENTS.md'), longContent);
      const ctx = loadProjectContext(dir);
      expect(ctx?.content).not.toContain('[...truncated]');
      expect(ctx?.content).not.toContain('truncated');
    });
  });

  describe('interface shape', () => {
    it('returned object has content and source fields only', () => {
      writeFileSync(join(dir, 'AGENTS.md'), 'hello');
      const ctx = loadProjectContext(dir);
      expect(ctx).not.toBeNull();
      expect(typeof ctx?.content).toBe('string');
      expect(typeof ctx?.source).toBe('string');
      expect('truncated' in (ctx ?? {})).toBe(false);
    });

    it('content matches file exactly', () => {
      const content = '# Project\n\n- Use npm test\n- TypeScript 5\n';
      writeFileSync(join(dir, 'AGENTS.md'), content);
      const ctx = loadProjectContext(dir);
      expect(ctx?.content).toBe(content);
    });
  });
});
