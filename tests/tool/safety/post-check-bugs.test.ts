import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { damageCheckHook } from '../../../src/tool/safety/post-check.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Bug 6: The regex /g flag causes lastIndex to persist between while loops.
// detectDeletedFunctions uses a /g regex, scans `original`, then scans `modified`
// with the SAME regex instance. After the first scan, lastIndex is past the end,
// so the second scan immediately returns null. Result:
// - modifiedFunctions is always empty → ALL original functions are falsely reported as "deleted"
// - modifiedSigs is always empty → signature changes are never detected

const TEST_DIR = '.test-post-check-bugs';

describe('Bug 6: regex /g lastIndex causes false positives in damageCheckHook', () => {
  beforeEach(async () => {
    if (!existsSync(TEST_DIR)) {
      await mkdir(TEST_DIR, { recursive: true });
    }
  });

  afterEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('does NOT report functions as deleted when they exist in both original and modified', async () => {
    const testFile = join(TEST_DIR, 'same-functions.ts');

    const original = `
export function foo() { return 1; }
export function bar() { return 2; }
`;
    const modified = `
export function foo() { return 1; }
export function bar() { return 2; }
export function baz() { return 3; }
`;

    await writeFile(testFile, modified, 'utf-8');

    // Bug 6: damageCheckHook.check() calls detectDeletedFunctions internally.
    // Because the /g regex's lastIndex persists, modifiedFunctions is empty,
    // so ALL original functions (foo, bar) are falsely reported as "deleted".
    // check() returns false (damage detected) — a CRITICAL false positive.
    const result = await damageCheckHook.check(testFile, original);

    // After fix: foo and bar still exist, no functions were deleted → check should pass.
    expect(result).toBe(true);
  });

  it('does NOT report false positives when functions are identical', async () => {
    const testFile = join(TEST_DIR, 'identical.ts');

    const content = `
export function alpha() { return 1; }
export function beta() { return 2; }
export function gamma() { return 3; }
`;

    await writeFile(testFile, content, 'utf-8');

    // Bug 6: Even with IDENTICAL content, the /g regex bug causes
    // modifiedFunctions to be empty, so all functions are reported as deleted.
    const result = await damageCheckHook.check(testFile, content);

    // After fix: identical content → no damage → should return true.
    expect(result).toBe(true);
  });

  it('detects actual signature changes when function parameters change', async () => {
    const testFile = join(TEST_DIR, 'sig-change.ts');

    const original = `export function process(x: string): void {}`;
    const modified = `export function process(x: string, y: number): void {}`;

    await writeFile(testFile, modified, 'utf-8');

    // Bug 6: detectSignatureChanges uses the same /g regex pattern.
    // After scanning original, lastIndex is past the end.
    // The second scan (on modified) gets zero matches → modifiedSigs is empty.
    // No signature changes are ever detected — a MISS.
    const result = await damageCheckHook.check(testFile, original);

    // After fix: the signature changed → should return false (damage detected).
    expect(result).toBe(false);
  });

  it('only reports actually deleted functions, not all of them', async () => {
    const testFile = join(TEST_DIR, 'partial-delete.ts');

    const original = `
function alpha() {}
function beta() {}
function gamma() {}
`;
    const modified = `
function alpha() {}
function gamma() {}
`;

    await writeFile(testFile, modified, 'utf-8');

    // Bug 6: modifiedFunctions is empty due to /g bug.
    // So alpha, beta, gamma are ALL reported as deleted.
    // check() returns false even though only beta was actually deleted.
    const result = await damageCheckHook.check(testFile, original);

    // After fix: only beta was deleted → should return false (damage detected).
    // This is the correct behavior — the bug is that it reports ALL as deleted.
    expect(result).toBe(false);
  });
});
