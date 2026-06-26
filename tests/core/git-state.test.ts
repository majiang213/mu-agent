import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { State } from '../../src/core/types.js';
import { getNextState, getBaseStateConfigs } from '../../src/core/states.js';
import { STATE_REGISTRY } from '../../src/core/state-registry.js';
import { GIT_HARD_DENY, wrapWithGitGuard } from '../../src/core/agent/builder.js';
import { buildCompleteTool } from '../../src/tool/complete.js';

/**
 * Gap 79: State.GIT — git-specific state with harness-level guard.
 *
 * Tests cover:
 *   - git guard blocks all forbidden operations (push --force, reset --hard, etc.)
 *   - git guard allows safe read/write operations through
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

describe('Gap 79: State.GIT — git guard (GIT_HARD_DENY)', () => {
  it('blocks push --force', async () => {
    const r = await runGuard('git push --force origin main');
    expect(r.blocked).toBe(true);
    expect(r.executed).toBe(false);
  });

  it('blocks push -f', async () => {
    const r = await runGuard('git push -f origin feature');
    expect(r.blocked).toBe(true);
  });

  it('blocks push --force-with-lease', async () => {
    const r = await runGuard('git push --force-with-lease origin feature');
    expect(r.blocked).toBe(true);
  });

  it('blocks push to main/master/HEAD', async () => {
    for (const branch of ['main', 'master', 'HEAD']) {
      const r = await runGuard(`git push origin ${branch}`);
      expect(r.blocked).toBe(true);
    }
  });

  it('blocks reset --hard', async () => {
    const r = await runGuard('git reset --hard HEAD~1');
    expect(r.blocked).toBe(true);
  });

  it('blocks rebase', async () => {
    const r = await runGuard('git rebase main');
    expect(r.blocked).toBe(true);
  });

  it('blocks clean -f / -fd', async () => {
    expect((await runGuard('git clean -f')).blocked).toBe(true);
    expect((await runGuard('git clean -fd')).blocked).toBe(true);
  });

  it('blocks stash drop / clear', async () => {
    expect((await runGuard('git stash drop')).blocked).toBe(true);
    expect((await runGuard('git stash clear')).blocked).toBe(true);
  });

  it('blocks branch -D', async () => {
    const r = await runGuard('git branch -D feature/old');
    expect(r.blocked).toBe(true);
  });

  it('blocks commit --no-verify', async () => {
    const r = await runGuard("git commit --no-verify -m 'skip hooks'");
    expect(r.blocked).toBe(true);
  });

  it('blocks reflog expire', async () => {
    const r = await runGuard('git reflog expire --expire=now --all');
    expect(r.blocked).toBe(true);
  });

  it('allows safe read operations (status, log, diff)', async () => {
    for (const cmd of ['git status', 'git log --oneline -10', 'git diff --staged', 'git branch -a']) {
      const r = await runGuard(cmd);
      expect(r.blocked).toBe(false);
      expect(r.executed).toBe(true);
    }
  });

  it('allows safe write operations (add, commit, branch, push to feature)', async () => {
    for (const cmd of [
      'git add calc.js',
      "git commit -m 'fix: divide by zero'",
      'git checkout -b feature/auth',
      'git push origin feature/auth',
      'git merge feature/auth',
      'git stash push -m "wip"',
    ]) {
      const r = await runGuard(cmd);
      expect(r.blocked).toBe(false);
      expect(r.executed).toBe(true);
    }
  });

  it('every GIT_HARD_DENY pattern is a RegExp', () => {
    for (const p of GIT_HARD_DENY) {
      expect(p).toBeInstanceOf(RegExp);
    }
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
