import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SafeModifier } from '../../../src/tool/safety/checkpoint.js';
import { writeFile, readFile, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = '.test-checkpoint-bugs';
const CHECKPOINT_DIR = join(TEST_DIR, 'checkpoints');

describe('restoreAndClearWhere(owner): per-step checkpoint cleanup', () => {
  beforeEach(async () => {
    if (!existsSync(TEST_DIR)) {
      await mkdir(TEST_DIR, { recursive: true });
    }
    if (existsSync(CHECKPOINT_DIR)) {
      await rm(CHECKPOINT_DIR, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('restores the owner file content and removes its .bak from disk', async () => {
    const testFile = join(TEST_DIR, 'test.ts');
    await writeFile(testFile, 'original content', 'utf-8');

    const owner = { step: 'A' };
    const modifier = new SafeModifier(CHECKPOINT_DIR);
    await modifier.createCheckpoint(testFile, owner);

    // The failed step partially edited the file.
    await writeFile(testFile, 'partial edit', 'utf-8');
    expect((await readdir(CHECKPOINT_DIR)).filter((e) => e.endsWith('.bak')).length).toBe(1);

    await modifier.restoreAndClearWhere(owner);

    // Partial edit undone; checkpoint and its .bak gone.
    expect(await readFile(testFile, 'utf-8')).toBe('original content');
    expect(modifier.hasCheckpoint(testFile)).toBe(false);
    expect((await readdir(CHECKPOINT_DIR)).filter((e) => e.endsWith('.bak')).length).toBe(0);
  });

  it('leaves other owners checkpoints and .bak files intact (parallel-branch safety)', async () => {
    const fileA = join(TEST_DIR, 'a.ts');
    const fileB = join(TEST_DIR, 'b.ts');
    await writeFile(fileA, 'content a', 'utf-8');
    await writeFile(fileB, 'content b', 'utf-8');

    const branchA = { branch: 'A' };
    const branchB = { branch: 'B' };
    const modifier = new SafeModifier(CHECKPOINT_DIR);
    await modifier.createCheckpoint(fileA, branchA);
    await modifier.createCheckpoint(fileB, branchB);

    // Branch A fails and retries: only its own checkpoint is restored+cleared.
    await writeFile(fileA, 'partial a', 'utf-8');
    await modifier.restoreAndClearWhere(branchA);

    expect(await readFile(fileA, 'utf-8')).toBe('content a');
    expect(modifier.hasCheckpoint(fileA)).toBe(false);
    // Branch B's checkpoint is fully intact — rollback for B stays armed.
    expect(modifier.hasCheckpoint(fileB)).toBe(true);
    expect((await readdir(CHECKPOINT_DIR)).filter((e) => e.endsWith('.bak')).length).toBe(1);

    await writeFile(fileB, 'partial b', 'utf-8');
    expect(await modifier.restore(fileB)).toBe(true);
    expect(await readFile(fileB, 'utf-8')).toBe('content b');
  });

  it('checkpoints without an owner are never touched', async () => {
    const testFile = join(TEST_DIR, 'legacy.ts');
    await writeFile(testFile, 'content', 'utf-8');

    const modifier = new SafeModifier(CHECKPOINT_DIR);
    await modifier.createCheckpoint(testFile); // no owner

    await modifier.restoreAndClearWhere({ some: 'step' });
    expect(modifier.hasCheckpoint(testFile)).toBe(true);
  });

  it('restore() no longer finds the .bak after restoreAndClearWhere', async () => {
    const testFile = join(TEST_DIR, 'stale.ts');
    await writeFile(testFile, 'current content', 'utf-8');

    const owner = { step: 'run1' };
    const modifier = new SafeModifier(CHECKPOINT_DIR);
    await modifier.createCheckpoint(testFile, owner);
    await writeFile(testFile, 'modified content', 'utf-8');

    await modifier.restoreAndClearWhere(owner);
    // File was restored to pre-edit; the .bak is gone, so a later restore
    // cannot resurrect stale content.
    expect(await modifier.restore(testFile)).toBe(false);
  });
});
