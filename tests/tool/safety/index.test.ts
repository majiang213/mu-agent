import { describe, it, expect, beforeEach } from 'vitest';
import { SafeModifier } from '../../../src/tool/safety/checkpoint.js';
import { LineLimitChecker } from '../../../src/tool/safety/line-limits.js';
import { syntaxCheckHook, damageCheckHook, runPostChecks } from '../../../src/tool/safety/post-check.js';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = '.test-safety';

describe('SafeModifier', () => {
  const testFile = join(TEST_DIR, 'test.ts');

  beforeEach(async () => {
    if (!existsSync(TEST_DIR)) {
      await mkdir(TEST_DIR, { recursive: true });
    }
    await writeFile(testFile, 'original content', 'utf-8');
  });

  it('should create checkpoint', async () => {
    const modifier = new SafeModifier();
    await modifier.createCheckpoint(testFile);

    expect(modifier.hasCheckpoint(testFile)).toBe(true);
  });

  it('should restore from checkpoint', async () => {
    const modifier = new SafeModifier();
    await modifier.createCheckpoint(testFile);

    await writeFile(testFile, 'modified content', 'utf-8');
    await modifier.restore(testFile);

    const content = await readFile(testFile, 'utf-8');
    expect(content).toBe('original content');
  });
});

describe('LineLimitChecker', () => {
  it('should allow small modifications', () => {
    const checker = new LineLimitChecker();
    const original = 'line1\nline2\nline3';
    const modified = 'line1\nmodified\nline3';

    const result = checker.check(original, modified, 'default');
    expect(result.allowed).toBe(true);
  });

  it('should reject large modifications', () => {
    const checker = new LineLimitChecker();
    const original = 'line1';
    const modified = Array(50).fill('line').join('\n');

    const result = checker.check(original, modified, 'default');
    expect(result.allowed).toBe(false);
  });
});

describe('PostCheckHooks', () => {
  const testFile = join(TEST_DIR, 'syntax-test.ts');

  beforeEach(async () => {
    if (!existsSync(TEST_DIR)) {
      await mkdir(TEST_DIR, { recursive: true });
    }
  });

  it('should pass syntax check for valid file', async () => {
    await writeFile(testFile, 'const x = 1;', 'utf-8');
    const passed = await syntaxCheckHook.check(testFile, '');
    expect(passed).toBe(true);
  });

  it('should fail syntax check for invalid braces', async () => {
    await writeFile(testFile, 'function test() {', 'utf-8');
    const passed = await syntaxCheckHook.check(testFile, '');
    expect(passed).toBe(false);
  });
});
