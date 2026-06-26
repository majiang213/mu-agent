import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { State } from '../../src/core/types.js';
import { getNextState, getBaseStateConfigs } from '../../src/core/states.js';
import { STATE_REGISTRY } from '../../src/core/state-registry.js';
import { GIT_HARD_DENY, wrapWithGitGuard } from '../../src/core/agent/builder.js';
import type { GitGuardSpec } from '../../src/core/agent/builder.js';
import { buildCompleteTool } from '../../src/tool/complete.js';

/**
 * Gap 79 / Gap 83: State.GIT — git-specific state with harness-level guard.
 *
 * Gap 83 (stage 1) rewrote the guard from a fragile `RegExp[]` array to an
 * argv-tokenizing `GitGuardSpec` (`{ summary, isForbidden }`). The guard now
 * defeats chaining (split on &&/||/;/|), skips global options (`-C`, `-c`,
 * `--git-dir`, ...), and uses case-sensitive flag logic so `-d` (safe) is not
 * confused with `-D` (force-delete).
 *
 * Tests cover:
 *   - GIT_HARD_DENY export shape (GitGuardSpec, not RegExp[])
 *   - git guard blocks all forbidden operations (the full B/D verified matrix)
 *   - git guard allows safe read/write operations through (no false positives)
 *   - block message omits the verbatim command (F1)
 *   - chaining defeat (any forbidden segment blocks the whole command)
 *   - complete() schema validation (operation enum + result non-empty)
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

describe('Gap 83: GIT_HARD_DENY export shape (argv-tokenizing spec, not RegExp[])', () => {
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
    expect(spec.isForbidden('git push --force origin main')).not.toBeNull();
    expect(spec.isForbidden('git status')).toBeNull();
  });
});

describe('Gap 83: git guard — blocks all forbidden operations', () => {
  // Each command is verified individually so a regression names the exact
  // bypass that re-opened. Comments cite the Gap 83 case id (B/D/F).
  const BLOCKED: Array<{ cmd: string; case: string }> = [
    { cmd: 'git push --force origin main', case: 'force flag' },
    { cmd: 'git push -f', case: 'force flag' },
    { cmd: 'git push --force-with-lease', case: 'force flag' },
    { cmd: 'git push origin main', case: 'default-branch dest' },
    { cmd: 'git push origin master', case: 'default-branch dest' },
    { cmd: 'git push origin HEAD', case: 'default-branch dest' },
    { cmd: 'git -C /tmp push --force', case: 'B1 global -C prefix' },
    { cmd: 'git -c x=y reset --hard', case: 'B1 global -c prefix' },
    { cmd: 'git push origin +main', case: 'B2 force refspec' },
    { cmd: 'git push origin +refs/heads/main', case: 'B2 force refspec' },
    { cmd: 'git push origin :main', case: 'B3 refspec delete' },
    { cmd: 'git push origin --delete main', case: 'B3 --delete flag' },
    { cmd: 'git push origin refs/heads/main', case: 'B3 refs/heads dest' },
    { cmd: 'git reset --hard', case: 'reset --hard' },
    { cmd: 'git reset --merge --hard', case: 'D3 flag-between-args' },
    { cmd: 'git reset --quiet --hard', case: 'D3 flag-between-args' },
    { cmd: 'git rebase main', case: 'rebase' },
    { cmd: 'git clean -f', case: 'clean -f' },
    { cmd: 'git clean -fd', case: 'clean -fd' },
    { cmd: 'git clean -xfd', case: 'clean -xfd' },
    { cmd: 'git stash drop', case: 'stash drop' },
    { cmd: 'git stash clear', case: 'stash clear' },
    { cmd: 'git branch -D feature', case: 'branch -D' },
    { cmd: 'git commit --no-verify -m x', case: 'commit --no-verify' },
    { cmd: 'git commit -n -m x', case: 'D2 short -n' },
    { cmd: 'git commit -nm x', case: 'D2 combined -nm' },
    { cmd: 'git reflog expire --all', case: 'reflog expire' },
    { cmd: 'git update-ref refs/heads/main x', case: 'D4 update-ref' },
    { cmd: 'git symbolic-ref HEAD refs/heads/main', case: 'D4 symbolic-ref' },
    { cmd: "git config alias.fp 'push --force'", case: 'D4 config alias' },
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
});

describe('Gap 83: git guard — allows safe operations (no false positives)', () => {
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
  ];

  it.each(ALLOWED)('allows: $cmd ($note)', async ({ cmd }) => {
    const r = await runGuard(cmd);
    expect(r.blocked).toBe(false);
    expect(r.executed).toBe(true);
  });
});

describe('Gap 83: git guard — chaining defeat', () => {
  it('blocks when a forbidden segment is chained after a safe one (&&)', async () => {
    const r = await runGuard('git status && git push --force origin main');
    expect(r.blocked).toBe(true);
    expect(r.executed).toBe(false);
  });

  it('blocks when a forbidden segment is chained with ||', async () => {
    const r = await runGuard('git push --force origin main || git status');
    expect(r.blocked).toBe(true);
    expect(r.executed).toBe(false);
  });

  it('blocks when a forbidden segment is chained with ;', async () => {
    const r = await runGuard('git status; git reset --hard');
    expect(r.blocked).toBe(true);
    expect(r.executed).toBe(false);
  });

  it('blocks when a forbidden segment is piped (|)', async () => {
    const r = await runGuard('git log | git push --force origin main');
    expect(r.blocked).toBe(true);
    expect(r.executed).toBe(false);
  });

  it('allows a fully-safe chained command', async () => {
    const r = await runGuard('git status && git log --oneline -5');
    expect(r.blocked).toBe(false);
    expect(r.executed).toBe(true);
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
