import { syntaxCheckHook, damageCheckHook } from './post-check.js';
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
 */
export async function runEditPostCheck(safeModifier: SafeModifier, filePath: string): Promise<PostCheckOutcome> {
  const checkpoint = safeModifier.getCheckpoint(filePath);
  const originalContent = checkpoint?.originalContent ?? '';
  const [syntaxOk, damageOk] = await Promise.all([
    syntaxCheckHook.check(filePath, originalContent),
    damageCheckHook.check(filePath, originalContent),
  ]);

  if (syntaxOk && damageOk) {
    safeModifier.clearCheckpoint(filePath);
    return { ok: true, steerMessage: null };
  }

  try {
    await safeModifier.restore(filePath);
    return {
      ok: false,
      steerMessage: `[SAFE MODIFIER] Post-check failed for ${filePath} (syntax=${syntaxOk}, damage=${damageOk}). File restored.`,
    };
  } catch (restoreErr) {
    console.error('[SafeModifier] restore() failed for', filePath, ':', restoreErr);
    return {
      ok: false,
      steerMessage: `[SAFE MODIFIER] Post-check failed AND restore failed for ${filePath}: ${String(restoreErr)}. File may be damaged.`,
    };
  }
}
