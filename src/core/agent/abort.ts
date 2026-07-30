/**
 * Classify "user pressed Esc" (or the harness's own complete()-driven abort)
 * versus a real error. One vocabulary for the whole system — previously
 * sniffed as 'abort' vs 'aborted' with divergent spellings in three modules,
 * where the bare 'abort' match false-positived on any error text containing
 * "abort" (e.g. an error mentioning `git merge --abort`).
 */
export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.message.includes('aborted');
}
