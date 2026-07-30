import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { RunConfig } from './types.js';
import { wrapWithGitGuard } from '../../tool/safety/git-guard.js';

/**
 * Per-step tool policy: EVERY bash tool gets the git guard (Gap 83/84 —
 * the guard is state-agnostic so a misrouted state cannot bypass it).
 * Named and exported so the wiring is tested directly, not mirrored by a
 * copy in tests (second-pass review, candidate 8).
 */
export function applyStateToolPolicy(tools: AgentTool[]): AgentTool[] {
  return tools.map((t) => (t.name === 'bash' ? wrapWithGitGuard(t) : t));
}

/**
 * Per-step / per-branch RunConfig fork semantics — one place that knows
 * what is shared across the whole run versus isolated per step.
 *
 * SHARED (forks carry the parent's reference):
 * - safeModifier — the checkpoint store. Parallel branches must NOT fork it:
 *   their checkpoints used to go to branch-local instances that were
 *   discarded, so rollbackEditedFiles (which reads the parent's store)
 *   silently restored nothing. (Architecture review 2026-07-30, candidate 3.)
 * - env / model / projectRoot / safetyConfig / apiKey
 *
 * FORKED per parallel branch:
 * - stateMachine — cloned, so branch file-count limits are independent.
 *
 * Temperature is per-step, not per-fork: runStep / runReasonAttempt spread
 * RunConfig before building their agent, so runStepAgent's retry-time
 * escalation writes to a step-local copy — the shared RunConfig is never
 * mutated (third-pass review, candidate 14).
 */
export function forkParallelBranchConfig(cfg: RunConfig): RunConfig {
  return { ...cfg, stateMachine: cfg.stateMachine.clone() };
}

/**
 * Files edited by more than one parallel branch. Checkpoint ordering across
 * branches is undefined for these, so rollback may not restore the original
 * content — the harness surfaces them via a parallel_overlap event.
 */
export function findOverlappingEdits(perBranchFiles: string[][]): string[] {
  const counts = new Map<string, number>();
  for (const files of perBranchFiles) {
    for (const f of new Set(files)) {
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([f]) => f);
}
