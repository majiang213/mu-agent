import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import type { SafeModifier } from './checkpoint.js';

export interface PostCheckOutcome {
  ok: boolean;
  /** Model-facing message to steer with when the check failed (null when ok). */
  steerMessage: string | null;
}

/**
 * Post-edit pipeline: syntax + damage checks against the checkpoint, then
 * restore-on-failure / clear-on-success. One home for the protocol that used
 * to be orchestrated inline inside builder.ts's event subscription
 * (architecture review 2026-07-30, candidate 5).
 *
 * The two checks are plain functions — the PostCheckHook interface they used
 * to implement was a speculative seam (two hardcoded implementations, no
 * injection point, `name` never read; round-7, candidate 9).
 */
export async function runEditPostCheck(safeModifier: SafeModifier, filePath: string): Promise<PostCheckOutcome> {
  const checkpoint = safeModifier.getCheckpoint(filePath);
  const originalContent = checkpoint?.originalContent ?? '';
  const [syntax, damage] = await Promise.all([syntaxOk(filePath), damageOk(filePath, originalContent)]);

  if (syntax && damage) {
    safeModifier.clearCheckpoint(filePath);
    return { ok: true, steerMessage: null };
  }

  try {
    await safeModifier.restore(filePath);
    return {
      ok: false,
      steerMessage: `[SAFE MODIFIER] Post-check failed for ${filePath} (syntax=${syntax}, damage=${damage}). File restored.`,
    };
  } catch (restoreErr) {
    console.error('[SafeModifier] restore() failed for', filePath, ':', restoreErr);
    return {
      ok: false,
      steerMessage: `[SAFE MODIFIER] Post-check failed AND restore failed for ${filePath}: ${String(restoreErr)}. File may be damaged.`,
    };
  }
}

/** TypeScript/JavaScript syntax check (other extensions pass vacuously). */
export async function syntaxOk(filePath: string): Promise<boolean> {
  try {
    const ext = filePath.split('.').pop() ?? '';
    if (!['ts', 'tsx', 'js', 'jsx'].includes(ext)) return true;
    const program = ts.createProgram([filePath], {
      noEmit: true,
      allowJs: true,
      skipLibCheck: true,
      noResolve: true,
    });
    const diags = ts.getPreEmitDiagnostics(program);
    return diags.length === 0;
  } catch {
    return true;
  }
}

/** Damage detection: deleted functions or changed export signatures vs the checkpoint. */
export async function damageOk(filePath: string, originalContent: string): Promise<boolean> {
  try {
    const modifiedContent = await readFile(filePath, 'utf-8');

    // Detect deleted functions
    const deletedFunctions = detectDeletedFunctions(originalContent, modifiedContent);
    if (deletedFunctions.length > 0) {
      console.error(`Damage detected: Deleted functions ${deletedFunctions.join(', ')}`);
      return false;
    }

    // Detect signature changes
    const signatureChanges = detectSignatureChanges(originalContent, modifiedContent);
    if (signatureChanges.length > 0) {
      console.error(`Damage detected: Signature changes in ${signatureChanges.join(', ')}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`Failed to check damage for ${filePath}:`, error);
    return false;
  }
}

/**
 * Detect deleted functions
 */
function detectDeletedFunctions(original: string, modified: string): string[] {
  const functionPattern = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;

  const originalFunctions = new Set<string>();
  for (const match of original.matchAll(functionPattern)) {
    if (match[1]) originalFunctions.add(match[1]);
  }

  const modifiedFunctions = new Set<string>();
  for (const match of modified.matchAll(functionPattern)) {
    if (match[1]) modifiedFunctions.add(match[1]);
  }

  const deleted: string[] = [];
  for (const func of originalFunctions) {
    if (!modifiedFunctions.has(func)) {
      deleted.push(func);
    }
  }

  return deleted;
}

/**
 * Detect signature changes
 */
function detectSignatureChanges(original: string, modified: string): string[] {
  // Simplified: check if exported function signatures changed
  const signaturePattern = /export\s+(?:async\s+)?function\s+(\w+)\s*\([^)]*\)/g;

  const originalSigs = new Map<string, string>();
  for (const match of original.matchAll(signaturePattern)) {
    if (match[1]) originalSigs.set(match[1], match[0]);
  }

  const modifiedSigs = new Map<string, string>();
  for (const match of modified.matchAll(signaturePattern)) {
    if (match[1]) modifiedSigs.set(match[1], match[0]);
  }

  const changed: string[] = [];
  for (const [name, origSig] of originalSigs) {
    const modSig = modifiedSigs.get(name);
    if (modSig && modSig !== origSig) {
      changed.push(name);
    }
  }

  return changed;
}
