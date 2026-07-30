import type { StepDirective } from '../types.js';
import type { PlanCandidate } from './types.js';
import { directiveFingerprint, planFingerprint } from '../agent/directives.js';

/**
 * Plan-set algebra — ONE HOME for the similarity/dedup operations Heavy
 * Thinking needs. Previously the exact-fingerprint set logic was implemented
 * four separate ways in sampler.ts (dedup, allSeenBefore, roundConverged,
 * plus an inline "new in batch" filter) and the fuzzy version once more in
 * deliberator.ts (jaccardDirectives, allPlansSimilar) — all leaning on the
 * same directive fingerprints (third-pass review, candidate 11).
 */

/** First occurrence wins; two plans are identical when their fingerprints match. */
export function dedupPlans(candidates: PlanCandidate[]): PlanCandidate[] {
  const seen = new Map<string, PlanCandidate>();
  for (const c of candidates) {
    const fp = planFingerprint(c.steps);
    if (!seen.has(fp)) seen.set(fp, c);
  }
  return [...seen.values()];
}

/** All plans in the batch share one fingerprint (or the batch is a singleton). */
export function roundConverged(roundCandidates: PlanCandidate[]): boolean {
  if (roundCandidates.length <= 1) return true;
  const fps = new Set(roundCandidates.map((c) => planFingerprint(c.steps)));
  return fps.size === 1;
}

/**
 * Every plan in `batch` already exists in `existing`. An empty batch returns
 * false — a failed round carries no information, it must not stop sampling.
 */
export function allSeenBefore(batch: PlanCandidate[], existing: PlanCandidate[]): boolean {
  if (batch.length === 0) return false;
  const existingFps = new Set(existing.map((c) => planFingerprint(c.steps)));
  return batch.every((c) => existingFps.has(planFingerprint(c.steps)));
}

/** Plans in `batch` whose fingerprint is not already present in `existing`. */
export function newPlans(batch: PlanCandidate[], existing: PlanCandidate[]): PlanCandidate[] {
  const existingFps = new Set(existing.map((c) => planFingerprint(c.steps)));
  return batch.filter((c) => !existingFps.has(planFingerprint(c.steps)));
}

/** Jaccard similarity over directive fingerprints (two empty plans → 1). */
export function jaccardPlans(a: StepDirective[], b: StepDirective[]): number {
  const setA = new Set(a.map(directiveFingerprint));
  const setB = new Set(b.map(directiveFingerprint));
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 1 : intersection / union;
}

/** Every pair of candidates is at least `threshold` similar. */
export function allPlansSimilar(candidates: PlanCandidate[], threshold = 0.8): boolean {
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (jaccardPlans(candidates[i]!.steps, candidates[j]!.steps) < threshold) return false;
    }
  }
  return true;
}
