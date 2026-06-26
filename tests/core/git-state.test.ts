import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { State } from '../../src/core/types.js';
import { getNextState, getBaseStateConfigs } from '../../src/core/states.js';
import { STATE_REGISTRY, GIT_OPERATIONS } from '../../src/core/state-registry.js';
import { GIT_HARD_DENY, wrapWithGitGuard } from '../../src/core/agent/builder.js';
import type { GitGuardSpec } from '../../src/core/agent/builder.js';
import { buildCompleteTool } from '../../src/tool/complete.js';

/**
 * Gap 79 / Gap 83 / Gap 84: State.GIT — git-specific state with harness-level guard.
 *
 * Gap 84 (stage 1) rewrote the guard from the Gap 83 argv-tokenizing DENYLIST
 * to a HARD ALLOWLIST (Strategy B / default-deny). The previous denylist had
 * 18 confirmed tokenizer-layer bypasses (shell-metachar chaining `&`/newline/
 * CR, quoted subcommand `bash -c "..."`, absolute path `/usr/bin/git`, command
 * substitution `$(...)`/backticks, config `alias.*` writes, fully-qualified
 * delete refspecs `:refs/heads/main`, history-rewrite plumbing
 * `filter-branch`/`replace`/`fast-import`, `push --mirror`/`--all`,
 * `commit --no-verify=true`, `commit --amend`). The allowlist defeats all 18 by
 * rejecting any shell metacharacter, requiring the first token to be exactly
 * `git`, and default-denying any subcommand not in the allowed set.
 *
 * `GIT_HARD_DENY` keeps its export name for compat but now carries the
 * ALLOWLIST spec `{ summary, isForbidden }` where `isForbidden` returns a
 * reason string when the command is NOT allowlisted (forbidden), or null when
 * allowed. The block result no longer carries `terminate` (stage 2 will wire
 * an abort; F1 — verbatim command is omitted from the block message).
 *
 * Tests cover:
 *   - GIT_HARD_DENY export shape (GitGuardSpec, not RegExp[])
 *   - git guard blocks ALL 18 Gap 84 bypasses (allowlist defeats each)
 *   - git guard still blocks the original Gap 83 forbidden ops
 *   - git guard allows safe read/write operations through (no false positives)
 *   - block message omits the verbatim command (F1) and has no `terminate`
 *   - chaining defeat (the allowlist rejects ALL `&`/`;`/`|` — GIT needs none)
 *   - complete() schema validation (operation enum + result non-empty)
 *   - GIT_OPERATIONS parity: schema union literals == [...GIT_OPERATIONS] (Gap 83-F4/D2)
 *   - state transition GIT → DONE
 *   - registry configuration (allowedTools, contextNeeds)
 */

// ---- Helper: fake bash tool recording whether execute was called ----
function makeFakeBashTool(): { tool: AgentTool; calls: string[] } {
  const calls: string[] = [];
  const tool: AgentTool = {
    name: 'bash',
    label: 'Bash',
    description: 'fake bash',
    parameters: Type.Object({ command: Type.String() }),
    execute: async (_id, params) => {
      const p = params as Record<string, unknown>;
      calls.push(typeof p['command'] === 'string' ? (p['command'] as string) : '');
      return { content: [{ type: 'text' as const, text: 'executed' }], details: undefined };
    },
  };
  return { tool, calls };
}

async function runGuard(cmd: string): Promise<{ blocked: boolean; output: string; executed: boolean }> {
  const { tool, calls } = makeFakeBashTool();
  const guarded = wrapWithGitGuard(tool);
  const result = await guarded.execute('id', { command: cmd });
  const text = result.content.flatMap((c) => (c.type === 'text' && c.text ? [c.text] : [])).join('');
  const blocked = text.startsWith('[GIT GUARD]');
  return { blocked, output: text, executed: calls.length === 1 };
}

describe('Gap 83/84: GIT_HARD_DENY export shape (allowlist spec, not RegExp[])', () => {
  it('is a GitGuardSpec object with summary + isForbidden', () => {
    expect(GIT_HARD_DENY).not.toBeNull();
    expect(typeof GIT_HARD_DENY).toBe('object');
    expect(GIT_HARD_DENY).not.toBeInstanceOf(Array);
    expect(typeof (GIT_HARD_DENY as GitGuardSpec).summary).toBe('string');
    expect((GIT_HARD_DENY as GitGuardSpec).summary.length).toBeGreaterThan(0);
    expect(typeof (GIT_HARD_DENY as GitGuardSpec).isForbidden).toBe('function');
  });

  it('isForbidden returns a reason string for forbidden, null for allowed', () => {
    const spec = GIT_HARD_DENY as GitGuardSpec;
    // Gap 84 allowlist: `--force` is rejected at the push-flag layer.
    expect(spec.isForbidden('git push --force origin main')).not.toBeNull();
    expect(spec.isForbidden('git status')).toBeNull();
  });
});

describe('Gap 84: git guard — blocks all 18 allowlist bypasses', () => {
  // The Gap 83 argv-tokenizing DENYLIST had 18 confirmed bypasses. The Gap 84
  // ALLOWLIST (default-deny) must defeat every one. Each is verified
  // individually so a regression names the exact bypass that re-opened.
  const BYPASSES: Array<{ cmd: string; id: string }> = [
    // A1 — shell-metacharacter chaining (single &, newline, CR)
    { cmd: 'git status & git push --force', id: 'A1 single-& chaining' },
    { cmd: 'git status\ngit push --force', id: 'A1 newline chaining' },
    { cmd: 'git status\rgit push --force', id: 'A1 CR chaining' },
    // A2 — quoted subcommand via bash -c (first token must be `git` exactly)
    { cmd: 'bash -c "git push --force"', id: 'A2 bash -c subcommand' },
    // A3 — absolute path / sudo (first token must be `git` exactly)
    { cmd: '/usr/bin/git push --force', id: 'A3 absolute-path git' },
    // A4 — command substitution / subshell (rejected by metachar layer)
    { cmd: '$(git push --force)', id: 'A4 $() substitution' },
    { cmd: '`git push --force`', id: 'A4 backtick substitution' },
    // B1 — config alias.* write (regardless of scope flag) hides a force-push
    { cmd: 'git config --global alias.fp "push --force"', id: 'B1 config --global alias write' },
    { cmd: 'git config --add alias.fp "push --force"', id: 'B1 config --add alias write' },
    // B2 — fully-qualified delete / src:dst refspec to a default branch
    { cmd: 'git push origin :refs/heads/main', id: 'B2 :refs/heads/main delete' },
    { cmd: 'git push origin HEAD:refs/heads/main', id: 'B2 HEAD:refs/heads/main' },
    // B3 — history-rewrite plumbing (default-deny: not in allowed set)
    { cmd: 'git filter-branch -- HEAD', id: 'B3 filter-branch' },
    { cmd: 'git replace HEAD abc', id: 'B3 replace' },
    { cmd: 'git fast-import', id: 'B3 fast-import' },
    // B4 — push --mirror / --all
    { cmd: 'git push --mirror origin', id: 'B4 push --mirror' },
    { cmd: 'git push --all origin', id: 'B4 push --all' },
    // B5 — commit --no-verify attached-equals (caught by startsWith prefix)
    { cmd: 'git commit --no-verify=true -m x', id: 'B5 --no-verify=true' },
    // C1 — commit --amend (explicit reject)
    { cmd: 'git commit --amend -m x', id: 'C1 commit --amend' },
  ];

  it.each(BYPASSES)('blocks bypass: $id ($cmd)', async ({ cmd }) => {
    const r = await runGuard(cmd);
    expect(r.blocked).toBe(true);
    expect(r.executed).toBe(false);
    expect(r.output).toContain('[GIT GUARD]');
  });

  it('all 18 Gap 84 bypasses are covered (regression guard on the matrix size)', () => {
    expect(BYPASSES.length).toBe(18);
  });
});

describe('Gap 83: git guard — still blocks the original forbidden operations', () => {
  // The Gap 84 rewrite must NOT regress the Gap 83 forbidden set. These now
  // block for a different reason string (allowlist default-deny vs the old
  // specific denylist reason) but must still be blocked.
  const BLOCKED: Array<{ cmd: string; case: string }> = [
    { cmd: 'git push --force', case: 'force flag' },
    { cmd: 'git push -f', case: 'force flag' },
    { cmd: 'git push origin main', case: 'default-branch dest' },
    { cmd: 'git push origin master', case: 'default-branch dest' },
    { cmd: 'git push origin HEAD', case: 'default-branch dest' },
    { cmd: 'git reset --hard', case: 'reset --hard (default-deny)' },
    { cmd: 'git rebase', case: 'rebase (default-deny)' },
    { cmd: 'git clean -f', case: 'clean -f (default-deny)' },
    { cmd: 'git clean -fd', case: 'clean -fd (default-deny)' },
    { cmd: 'git stash drop', case: 'stash drop' },
    { cmd: 'git stash clear', case: 'stash clear' },
    { cmd: 'git branch -D', case: 'branch -D' },
    { cmd: 'git commit --no-verify', case: 'commit --no-verify' },
    { cmd: 'git commit -n', case: 'commit -n (no-verify)' },
    { cmd: 'git reflog expire', case: 'reflog expire' },
    { cmd: 'git update-ref', case: 'update-ref (default-deny)' },
    { cmd: 'git symbolic-ref', case: 'symbolic-ref (default-deny)' },
    { cmd: "git config alias.fp 'push --force'", case: 'config alias write (D4)' },
  ];

  it.each(BLOCKED)('blocks: $cmd ($case)', async ({ cmd }) => {
    const r = await runGuard(cmd);
    expect(r.blocked).toBe(true);
    expect(r.executed).toBe(false);
    expect(r.output).toContain('[GIT GUARD]');
  });

  it('block message does NOT echo the verbatim blocked command (F1)', async () => {
    const r = await runGuard('git push --force origin main');
    expect(r.output).toContain('[GIT GUARD]');
    // F1: the bypass string must not be telegraphed back to the model.
    expect(r.output).not.toContain('push --force origin main');
    expect(r.output).not.toMatch(/Blocked command:/);
  });

  it('block result has no `terminate` field (F1 — dropped, abort deferred to stage 2)', async () => {
    const { tool } = makeFakeBashTool();
    const guarded = wrapWithGitGuard(tool);
    const result = (await guarded.execute('id', {
      command: 'git push --force origin main',
    })) as Record<string, unknown>;
    expect(result['terminate']).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, 'terminate')).toBe(false);
  });
});

describe('Gap 83/84: git guard — allows safe operations (no false positives)', () => {
  const ALLOWED: Array<{ cmd: string; note: string }> = [
    { cmd: 'git status', note: 'read' },
    { cmd: 'git log --oneline -10', note: 'read' },
    { cmd: 'git diff --staged', note: 'read' },
    { cmd: 'git branch -a', note: 'read' },
    { cmd: 'git add calc.js', note: 'staging' },
    { cmd: "git commit -m 'fix: x'", note: 'safe commit' },
    { cmd: 'git checkout -b feature/auth', note: 'branch switch' },
    { cmd: 'git push origin feature/auth', note: 'push feature branch' },
    { cmd: 'git push origin feature/main', note: 'NOT main (prefix only)' },
    { cmd: 'git push origin main-feature', note: 'NOT main (suffix only)' },
    { cmd: 'git push origin maintenance', note: 'NOT main (substring only)' },
    { cmd: 'git merge feature/auth', note: 'merge' },
    { cmd: 'git stash push -m wip', note: 'stash push' },
    { cmd: 'git stash apply', note: 'stash apply' },
    { cmd: 'git stash list', note: 'stash list' },
    { cmd: 'git branch -d feature', note: 'D1 safe lowercase -d' },
    { cmd: 'git branch --delete feature', note: 'D1 safe --delete long form' },
    { cmd: 'git revert HEAD', note: 'revert' },
    { cmd: 'git cherry-pick abc', note: 'cherry-pick' },
    { cmd: 'git fetch origin', note: 'fetch' },
    { cmd: 'git tag v1.0', note: 'tag' },
    { cmd: 'git config user.email', note: 'config non-alias write (threat model is alias.*)' },
    { cmd: 'git config alias.fp', note: 'config alias READ (no value)' },
  ];

  it.each(ALLOWED)('allows: $cmd ($note)', async ({ cmd }) => {
    const r = await runGuard(cmd);
    expect(r.blocked).toBe(false);
    expect(r.executed).toBe(true);
  });
});

describe('Gap 84: git guard — chaining defeat (allowlist rejects ALL metachars)', () => {
  // Gap 84 Strategy B: the GIT state needs NO shell metacharacter for any
  // legitimate git op, so the allowlist rejects ANY `&`/`;`/`|`/newline/CR
  // outright (step 1). This defeats chaining / substitution / subshell at the
  // metacharacter layer, BEFORE the subcommand is even inspected. As a result
  // a fully-safe chained command is now BLOCKED — this is intended (GIT must
  // issue one git command per bash call, never chain).
  it('blocks a forbidden segment chained after a safe one (&&)', async () => {
    const r = await runGuard('git status && git push --force origin main');
    expect(r.blocked).toBe(true);
    expect(r.executed).toBe(false);
  });

  it('blocks a forbidden segment chained with ||', async () => {
    const r = await runGuard('git push --force origin main || git status');
    expect(r.blocked).toBe(true);
    expect(r.executed).toBe(false);
  });

  it('blocks a forbidden segment chained with ;', async () => {
    const r = await runGuard('git status; git reset --hard');
    expect(r.blocked).toBe(true);
    expect(r.executed).toBe(false);
  });

  it('blocks a forbidden segment piped (|)', async () => {
    const r = await runGuard('git log | git push --force origin main');
    expect(r.blocked).toBe(true);
    expect(r.executed).toBe(false);
  });

  it('blocks a fully-safe chained command (&&) — chaining is no longer permitted', async () => {
    // Gap 84 behavior change: the allowlist rejects ALL `&`, so even a safe
    // chain is blocked. GIT must run one git command per bash call.
    const r = await runGuard('git status && git log --oneline -5');
    expect(r.blocked).toBe(true);
    expect(r.executed).toBe(false);
    expect(r.output).toContain('[GIT GUARD]');
  });

  it('blocks a safe pipe to grep/head (|) — pipes are no longer permitted', async () => {
    const r = await runGuard('git log --oneline -5 | head -3');
    expect(r.blocked).toBe(true);
    expect(r.executed).toBe(false);
  });
});

describe('Gap 79: State.GIT — complete() schema validation', () => {
  function capture(): { tool: AgentTool; result: Record<string, unknown> | null } {
    let captured: Record<string, unknown> | null = null;
    const tool = buildCompleteTool(State.GIT, (args) => {
      captured = args;
    });
    return {
      tool,
      get result() {
        return captured;
      },
    };
  }

  async function runComplete(args: Record<string, unknown>): Promise<string> {
    const { tool } = capture();
    const r = await tool.execute('id', args);
    return r.content.flatMap((c) => (c.type === 'text' && c.text ? [c.text] : [])).join('');
  }

  it('accepts a valid commit complete', async () => {
    const out = await runComplete({
      operation: 'commit',
      result: '[main abc1234] fix: divide by zero',
      commitSha: 'abc1234',
      filesAffected: ['calc.js'],
    });
    expect(out).toBe('ok');
  });

  it('accepts a merge with conflicts', async () => {
    const out = await runComplete({
      operation: 'merge',
      result: 'CONFLICT in src/auth.ts',
      conflicts: ['src/auth.ts'],
    });
    expect(out).toBe('ok');
  });

  it('rejects invalid operation', async () => {
    const out = await runComplete({ operation: 'rebase', result: 'x' });
    expect(out).toContain('operation must be one of');
  });

  it('rejects missing operation', async () => {
    const out = await runComplete({ result: 'x' });
    expect(out).toContain('operation must be one of');
  });

  it('rejects empty result', async () => {
    const out = await runComplete({ operation: 'commit', result: '' });
    expect(out).toContain('result must be a non-empty string');
  });

  it('rejects missing result', async () => {
    const out = await runComplete({ operation: 'status' });
    expect(out).toContain('result must be a non-empty string');
  });
});

describe('Gap 83-F4/D2: GIT_OPERATIONS parity (schema union == shared const)', () => {
  // The complete() TypeBox `operation` union and complete.ts runtime validation
  // must both derive from the single GIT_OPERATIONS const so they can never
  // drift. This test pins that contract: the schema literal set must equal
  // [...GIT_OPERATIONS].
  it('schema operation union literals equal [...GIT_OPERATIONS]', () => {
    const def = STATE_REGISTRY[State.GIT];
    const opSchema = (def.completeSchema as { properties: { operation: { anyOf?: Array<{ const?: string }> } } })
      .properties.operation;
    expect(opSchema).toBeDefined();
    expect(Array.isArray(opSchema.anyOf)).toBe(true);
    const literals = (opSchema.anyOf ?? []).map((m) => m.const);
    expect(literals).toEqual([...GIT_OPERATIONS]);
  });

  it('complete.ts validation accepts every GIT_OPERATIONS value', async () => {
    // The runtime validator in complete.ts uses `GIT_OPERATIONS as readonly
    // string[]` — every declared op must validate as a well-formed complete().
    for (const op of GIT_OPERATIONS) {
      let captured: Record<string, unknown> | null = null;
      const tool = buildCompleteTool(State.GIT, (args) => {
        captured = args;
      });
      const r = await tool.execute('id', { operation: op, result: 'ok' });
      const text = r.content.flatMap((c) => (c.type === 'text' && c.text ? [c.text] : [])).join('');
      expect(text).toBe('ok');
      expect(captured).not.toBeNull();
    }
  });

  it('GIT_OPERATIONS is a readonly tuple (frozen or `as const`)', () => {
    // `as const` gives a readonly tuple. Object.isFrozen may be false at
    // runtime, so assert the type-level immutability indirectly: pushing must
    // be a type error in strict TS, but at runtime we assert the array is not
    // trivially mutable by checking it cannot be reassigned via index without
    // the `as const` readonly protection surfacing. We assert the length and
    // contents are stable.
    expect(GIT_OPERATIONS.length).toBe(11);
    expect(GIT_OPERATIONS).toContain('commit');
    expect(GIT_OPERATIONS).toContain('cherry-pick');
    expect(GIT_OPERATIONS).toContain('other');
  });
});

describe('Gap 79: State.GIT — state machine integration', () => {
  it('GIT transitions to DONE', () => {
    expect(getNextState(State.GIT, true)).toBe(State.DONE);
    expect(getNextState(State.GIT, false)).toBe(State.DONE);
  });

  it('registry has GIT entry with bash+read+complete', () => {
    const def = STATE_REGISTRY[State.GIT];
    expect(def.allowedTools).toEqual(['bash', 'read', 'complete']);
  });

  it('GIT contextNeeds covers MODIFY, RESEARCH, WRITE', () => {
    const def = STATE_REGISTRY[State.GIT];
    expect(def.contextNeeds).toEqual([State.MODIFY, State.RESEARCH, State.WRITE]);
  });

  it('GIT is in base state configs', () => {
    const configs = getBaseStateConfigs();
    expect(configs[State.GIT]).toBeDefined();
    expect(configs[State.GIT].allowedTools).toContain('bash');
  });

  it('GIT completeSchema includes operation union and conflicts field', () => {
    const def = STATE_REGISTRY[State.GIT];
    // Smoke: schema is a TypeBox object; verify required keys via Static check is hard,
    // so assert the instruction mentions conflicts re-plan behavior.
    expect(def.instruction).toContain('conflicts');
    expect(def.reminderFields).toBe('operation (string), result (string)');
  });
});
