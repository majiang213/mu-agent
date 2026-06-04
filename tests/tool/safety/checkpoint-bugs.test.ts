import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SafeModifier } from '../../../src/tool/safety/checkpoint.js';
import { writeFile, readFile, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = '.test-checkpoint-bugs';
const CHECKPOINT_DIR = join(TEST_DIR, 'checkpoints');

describe('Bug 28: clearAll() only clears memory, not disk .bak files', () => {
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

  it('clearAll() removes .bak files from disk, not just from memory', async () => {
    // Arrange: create a file, checkpoint it (which saves to disk).
    const testFile = join(TEST_DIR, 'test.ts');
    await writeFile(testFile, 'original content', 'utf-8');

    const modifier = new SafeModifier(CHECKPOINT_DIR);
    await modifier.createCheckpoint(testFile);

    // Verify .bak file was written to disk
    const entries = await readdir(CHECKPOINT_DIR);
    const bakFiles = entries.filter((e) => e.endsWith('.bak'));
    expect(bakFiles.length).toBeGreaterThan(0);

    // Act: clearAll()
    modifier.clearAll();

    // Bug 28: clearAll() only calls this.checkpoints.clear() (line 87),
    // it does NOT delete the .bak files from disk.
    // After fix, the .bak files should also be deleted.
    const entriesAfter = await readdir(CHECKPOINT_DIR);
    const bakFilesAfter = entriesAfter.filter((e) => e.endsWith('.bak'));
    expect(bakFilesAfter.length).toBe(0);
  });

  it('restore() does not load stale .bak from a previous run after clearAll()', async () => {
    // Arrange: first "run" creates a checkpoint.
    const testFile = join(TEST_DIR, 'stale.ts');
    await writeFile(testFile, 'current content', 'utf-8');

    const modifier1 = new SafeModifier(CHECKPOINT_DIR);
    await modifier1.createCheckpoint(testFile);

    // Modify the file
    await writeFile(testFile, 'modified content', 'utf-8');

    // clearAll() — simulates end of run 1
    modifier1.clearAll();

    // Act: second "run" tries to restore.
    // Bug 28: loadFromDisk() finds the old .bak from run 1 and restores it,
    // overwriting the current content with stale data from the previous run.
    const modifier2 = new SafeModifier(CHECKPOINT_DIR);
    const restored = await modifier2.restore(testFile);

    // After fix: clearAll() should have deleted the .bak, so restore() returns false.
    // Bug: restore() returns true and overwrites with stale content.
    if (restored) {
      const content = await readFile(testFile, 'utf-8');
      // If restored, it should be from the CURRENT run's checkpoint, not a stale one.
      // Since modifier2 has no checkpoint, restore should return false.
      expect(content).toBe('modified content');
    } else {
      expect(restored).toBe(false);
    }
  });

  it('multiple .bak files from different files are all cleaned up by clearAll()', async () => {
    const file1 = join(TEST_DIR, 'a.ts');
    const file2 = join(TEST_DIR, 'b.ts');
    await writeFile(file1, 'content a', 'utf-8');
    await writeFile(file2, 'content b', 'utf-8');

    const modifier = new SafeModifier(CHECKPOINT_DIR);
    await modifier.createCheckpoint(file1);
    await modifier.createCheckpoint(file2);

    const entriesBefore = await readdir(CHECKPOINT_DIR);
    expect(entriesBefore.filter((e) => e.endsWith('.bak')).length).toBe(2);

    modifier.clearAll();

    // Bug 28: both .bak files remain on disk.
    const entriesAfter = await readdir(CHECKPOINT_DIR);
    expect(entriesAfter.filter((e) => e.endsWith('.bak')).length).toBe(0);
  });
});
