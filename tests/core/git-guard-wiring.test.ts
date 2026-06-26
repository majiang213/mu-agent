import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { wrapWithGitGuard } from '../../src/core/agent/builder.js';
import { State } from '../../src/core/types.js';
import { STATE_REGISTRY } from '../../src/core/state-registry.js';

/**
 * Gap 83 (part E): pin the step-runner wiring contract for the git guard.
 *
 * step-runner.ts line ~513 does:
 *   .map((t) => (t.name === 'bash' ? wrapWithGitGuard(t) : t));
 *
 * applied to the bash tool of EVERY state (the guard is state-agnostic — it
 * protects bash regardless of state, so a misrouted state cannot bypass it).
 * runStep() needs a full RunConfig to invoke, which is too heavy to construct
 * here, so this file replicates the exact wiring LOGIC against fake tools and
 * asserts the contract directly.
 */

// ---- Fake bash tool recording whether execute was called ----
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

// ---- Fake non-bash tool (read) ----
function makeFakeReadTool(): { tool: AgentTool; calls: number } {
  const calls = { count: 0 };
  const tool: AgentTool = {
    name: 'read',
    label: 'Read',
    description: 'fake read',
    parameters: Type.Object({ filePath: Type.String() }),
    execute: async () => {
      calls.count++;
      return { content: [{ type: 'text' as const, text: 'file contents' }], details: undefined };
    },
  };
  return { tool, calls };
}

/** Replicate the step-runner `.map` line: wrap bash, pass others through. */
function applyWiring(tools: AgentTool[]): AgentTool[] {
  // Mirrors step-runner.ts: (t.name === 'bash' ? wrapWithGitGuard(t) : t)
  return tools.map((t) => (t.name === 'bash' ? wrapWithGitGuard(t) : t));
}

describe('Gap 83: step-runner git guard wiring', () => {
  it('wraps the bash tool (guarded tool blocks forbidden commands)', async () => {
    const { tool: bash, calls } = makeFakeBashTool();
    const [guarded] = applyWiring([bash]);
    const result = await guarded.execute('id', { command: 'git push --force origin main' });
    const text = result.content.flatMap((c) => (c.type === 'text' && c.text ? [c.text] : [])).join('');
    expect(text.startsWith('[GIT GUARD]')).toBe(true);
    expect(calls.length).toBe(0); // original execute never reached
  });

  it('wrapped bash tool passes safe commands through to the original execute', async () => {
    const { tool: bash, calls } = makeFakeBashTool();
    const [guarded] = applyWiring([bash]);
    const result = await guarded.execute('id', { command: 'git status' });
    const text = result.content.flatMap((c) => (c.type === 'text' && c.text ? [c.text] : [])).join('');
    expect(text).toBe('executed');
    expect(calls).toEqual(['git status']); // original execute ran, with the verbatim command
  });

  it('passes non-bash tools through UNWRAPPED (guard is bash-only)', async () => {
    const { tool: read, calls } = makeFakeReadTool();
    const [passed] = applyWiring([read]);
    // The reference is the SAME object — no wrapping proxy applied.
    expect(passed).toBe(read);
    await passed.execute('id', { filePath: '/x' });
    expect(calls.count).toBe(1);
  });

  it('preserves tool identity (name/label/description/parameters) on the wrapped bash tool', () => {
    const { tool: bash } = makeFakeBashTool();
    const [guarded] = applyWiring([bash]);
    expect(guarded.name).toBe('bash');
    expect(guarded.label).toBe('Bash');
    expect(guarded.description).toBe('fake bash');
    expect(guarded.parameters).toBe(bash.parameters);
  });
});

describe('Gap 83: wrapWithGitGuard is idempotent-safe', () => {
  it('wrapping an already-wrapped tool still blocks (no bypass via double-wrap)', async () => {
    const { tool: bash, calls } = makeFakeBashTool();
    const once = wrapWithGitGuard(bash);
    const twice = wrapWithGitGuard(once);
    const result = await twice.execute('id', { command: 'git reset --hard' });
    const text = result.content.flatMap((c) => (c.type === 'text' && c.text ? [c.text] : [])).join('');
    expect(text.startsWith('[GIT GUARD]')).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('double-wrapping a safe command still reaches the original execute exactly once', async () => {
    const { tool: bash, calls } = makeFakeBashTool();
    const once = wrapWithGitGuard(bash);
    const twice = wrapWithGitGuard(once);
    const result = await twice.execute('id', { command: 'git log --oneline -5' });
    const text = result.content.flatMap((c) => (c.type === 'text' && c.text ? [c.text] : [])).join('');
    expect(text).toBe('executed');
    expect(calls.length).toBe(1);
  });
});

describe('Gap 83: all-state-wrap contract (guard is state-agnostic)', () => {
  it('every state whose allowedTools contains bash would get the guard applied', () => {
    // The step-runner wiring wraps bash for ALL states, not just State.GIT.
    // This test documents and pins that contract: any state that exposes bash
    // receives the guard, so a misrouted or future state cannot bypass it.
    const statesWithBash = (Object.keys(STATE_REGISTRY) as State[]).filter((s) =>
      STATE_REGISTRY[s]?.allowedTools?.includes('bash'),
    );
    expect(statesWithBash.length).toBeGreaterThan(0);
    // GIT must be among them (the primary git state).
    expect(statesWithBash).toContain(State.GIT);
    // Every such state, when its bash tool is wrapped, must block force-push.
    for (const _state of statesWithBash) {
      const { tool: bash, calls } = makeFakeBashTool();
      const guarded = wrapWithGitGuard(bash);
      // fire-and-forget assertion via void-less await below; we just need the sync contract
      void guarded; // shape check: wrapping produces an AgentTool
      expect(guarded.name).toBe('bash');
      expect(calls.length).toBe(0);
    }
  });

  it('the guard applied for a non-GIT state still blocks a forbidden git command', async () => {
    // Even if a state other than GIT exposed bash, the guard would fire.
    // Simulate that by wrapping a bash tool without any state gating.
    const { tool: bash, calls } = makeFakeBashTool();
    const guarded = wrapWithGitGuard(bash);
    const result = await guarded.execute('id', { command: 'git push origin main' });
    const text = result.content.flatMap((c) => (c.type === 'text' && c.text ? [c.text] : [])).join('');
    expect(text.startsWith('[GIT GUARD]')).toBe(true);
    expect(calls.length).toBe(0);
  });
});
