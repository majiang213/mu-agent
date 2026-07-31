import { isAbsolute, relative, resolve } from 'node:path';

export type ResolvedProjectPath = { ok: true; abs: string } | { ok: false };

/**
 * Resolve a model-given path against the project root and answer one
 * question: is it inside? THE one containment check (round-4, candidate 6).
 *
 * Previously builder.ts (checkpoint creation) and step-runner.ts (post-MODIFY
 * locator update) each hand-rolled the resolution, and builder's check was
 * weaker: `resolved.startsWith(projectRoot)` without normalization lets
 * un-normalized `../` segments and sibling-prefix paths (`/proj-evil/...`)
 * through. The resolution is also NORMALIZED here, so checkpoint keys are
 * canonical and hasCheckpoint lookups match createCheckpoint keys regardless
 * of the model's path style (relative / absolute / `./`-laden).
 *
 * Total: escaping or root-equal paths degrade to { ok: false }, never throws.
 */
export function resolveProjectPath(projectRoot: string, p: string): ResolvedProjectPath {
  const abs = isAbsolute(p) ? resolve(p) : resolve(projectRoot, p);
  const rel = relative(projectRoot, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false };
  }
  return { ok: true, abs };
}
