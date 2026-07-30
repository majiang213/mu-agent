import { setTimeout } from 'node:timers/promises';

/**
 * Minimal retry helper.
 *
 * Collapsed from the old four-level FailureHandler (architecture review
 * 2026-07-30): the RecoveryResult contract was dead at the only call site —
 * the caller did all retry bookkeeping itself and the strategies' newContext
 * payloads were never applied. The module's only real side effect was a 1s
 * sleep before the first retry, preserved here.
 */

/**
 * Delay before retry N (0-based failure count). Only the first retry waits —
 * preserves the old Level-1 strategy's effective behavior.
 */
export function retryDelayMs(attempt: number, baseMs = 1000): number {
  return attempt === 0 ? baseMs : 0;
}

/** Sleep for `ms` (no-op when 0). */
export async function sleep(ms: number): Promise<void> {
  if (ms > 0) await setTimeout(ms);
}
