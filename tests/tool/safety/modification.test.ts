import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runEditPostCheck } from '../../../src/tool/safety/modification.js';
import { SafeModifier } from '../../../src/tool/safety/checkpoint.js';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = '.test-modification';
const CHECKPOINT_DIR = join(TEST_DIR, 'checkpoints');

describe('runEditPostCheck', () => {
  beforeEach(async () => {
    if (!existsSync(TEST_DIR)) await mkdir(TEST_DIR, { recursive: true });
    if (existsSync(CHECKPOINT_DIR)) await rm(CHECKPOINT_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (existsSync(TEST_DIR)) await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('ok path: valid edit passes and clears the checkpoint', async () => {
    const file = join(TEST_DIR, 'ok.ts');
    await writeFile(file, 'const a = 1;\n', 'utf-8');
    const sm = new SafeModifier(CHECKPOINT_DIR);
    await sm.createCheckpoint(file);

    await writeFile(file, 'const a = 1;\nconst b = 2;\n', 'utf-8');
    const outcome = await runEditPostCheck(sm, file);

    expect(outcome.ok).toBe(true);
    expect(outcome.steerMessage).toBeNull();
    expect(sm.hasCheckpoint(file)).toBe(false);
    expect(await readFile(file, 'utf-8')).toBe('const a = 1;\nconst b = 2;\n');
  });

  it('fail path: syntax damage restores the checkpoint and returns a steer message', async () => {
    const file = join(TEST_DIR, 'broken.ts');
    await writeFile(file, 'function fine() { return 1; }\n', 'utf-8');
    const sm = new SafeModifier(CHECKPOINT_DIR);
    await sm.createCheckpoint(file);

    // Edit breaks the syntax (unclosed brace).
    await writeFile(file, 'function fine() { return 1;\n', 'utf-8');
    const outcome = await runEditPostCheck(sm, file);

    expect(outcome.ok).toBe(false);
    expect(outcome.steerMessage).toContain('[SAFE MODIFIER]');
    expect(outcome.steerMessage).toContain('restored');
    // File restored to the checkpoint content.
    expect(await readFile(file, 'utf-8')).toBe('function fine() { return 1; }\n');
  });

  it('damage path: deleted functions trigger restore (damageCheckHook)', async () => {
    const file = join(TEST_DIR, 'damage.ts');
    const original = 'export function keep() { return 1; }\nexport function gone() { return 2; }\n';
    await writeFile(file, original, 'utf-8');
    const sm = new SafeModifier(CHECKPOINT_DIR);
    await sm.createCheckpoint(file);

    // Edit deletes one of two exported functions.
    await writeFile(file, 'export function keep() { return 1; }\n', 'utf-8');
    const outcome = await runEditPostCheck(sm, file);

    expect(outcome.ok).toBe(false);
    expect(await readFile(file, 'utf-8')).toBe(original);
  });
});
