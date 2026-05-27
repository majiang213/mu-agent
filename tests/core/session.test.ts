import { describe, it, expect } from 'vitest';
import { StateMachineAgent } from '../../src/core/session.js';
import { State } from '../../src/core/types.js';

describe('StateMachineAgent', () => {
  describe('initialization', () => {
    it('starts in REASON state', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      expect(agent.getCurrentState()).toBe(State.REASON);
    });

    it('iteration starts at 0', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      expect(agent.getIteration()).toBe(0);
    });
  });

  describe('model tier detection', () => {
    it('7B param count → SMALL tier', () => {
      expect(new StateMachineAgent('model', [], 7e9).getModelParams().tier).toBe('SMALL');
    });

    it('8B param count → SMALL tier (≤9B threshold)', () => {
      expect(new StateMachineAgent('model', [], 8e9).getModelParams().tier).toBe('SMALL');
    });

    it('13B param count → MEDIUM tier', () => {
      expect(new StateMachineAgent('model', [], 13e9).getModelParams().tier).toBe('MEDIUM');
    });

    it('14B param count → MEDIUM tier', () => {
      expect(new StateMachineAgent('model', [], 14e9).getModelParams().tier).toBe('MEDIUM');
    });

    it('70B param count → LARGE tier', () => {
      expect(new StateMachineAgent('model', [], 70e9).getModelParams().tier).toBe('LARGE');
    });

    it('null param count (unknown/custom) → LARGE tier', () => {
      expect(new StateMachineAgent('model', [], null).getModelParams().tier).toBe('LARGE');
    });

    it('SMALL tier has strictPlanning=true', () => {
      expect(new StateMachineAgent('model', [], 7e9).getModelParams().strictPlanning).toBe(true);
    });

    it('SMALL tier has maxFilesPerTask=2', () => {
      expect(new StateMachineAgent('model', [], 7e9).getModelParams().maxFilesPerTask).toBe(2);
    });

    it('LARGE tier has strictPlanning=false', () => {
      expect(new StateMachineAgent('model', [], 70e9).getModelParams().strictPlanning).toBe(false);
    });
  });

  describe('state transitions', () => {
    it('transitions to LOCATE', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      agent.transitionTo(State.LOCATE);
      expect(agent.getCurrentState()).toBe(State.LOCATE);
    });

    it('resets iteration counter on transition', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      agent.incrementIteration();
      agent.incrementIteration();
      expect(agent.getIteration()).toBe(2);
      agent.transitionTo(State.LOCATE);
      expect(agent.getIteration()).toBe(0);
    });

    it('incrementIteration increments correctly', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      agent.incrementIteration();
      agent.incrementIteration();
      agent.incrementIteration();
      expect(agent.getIteration()).toBe(3);
    });
  });

  describe('getAllowedTools — exact tool sets per state', () => {
    function toolNames(agent: StateMachineAgent): string[] {
      return agent
        .getAllowedTools()
        .map((t) => t.name)
        .sort();
    }

    it('REASON → empty (complete is built separately, not in allTools)', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      agent.transitionTo(State.REASON);
      expect(toolNames(agent)).toHaveLength(0);
    });

    it('LOCATE → includes read and ast_code_locator, NOT grep/find/ls', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      agent.transitionTo(State.LOCATE);
      const names = toolNames(agent);
      expect(names).toContain('read');
      expect(names).not.toContain('grep');
      expect(names).not.toContain('find');
      expect(names).not.toContain('ls');
    });

    it('DIAGNOSE → includes read, bash, grep', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      agent.transitionTo(State.DIAGNOSE);
      const names = toolNames(agent);
      expect(names).toContain('read');
      expect(names).toContain('bash');
      expect(names).toContain('grep');
    });

    it('REVIEW → includes read, grep', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      agent.transitionTo(State.REVIEW);
      const names = toolNames(agent);
      expect(names).toContain('read');
      expect(names).toContain('grep');
    });

    it('RESEARCH → includes read, grep, find, ls, webfetch, websearch', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      agent.transitionTo(State.RESEARCH);
      const names = toolNames(agent);
      expect(names).toContain('read');
      expect(names).toContain('grep');
      expect(names).toContain('find');
      expect(names).toContain('ls');
    });

    it('MODIFY → includes read, edit, write', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      agent.transitionTo(State.MODIFY);
      const names = toolNames(agent);
      expect(names).toContain('read');
      expect(names).toContain('edit');
      expect(names).toContain('write');
    });

    it('MODIFY → does NOT include bash', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      agent.transitionTo(State.MODIFY);
      expect(toolNames(agent)).not.toContain('bash');
    });

    it('VERIFY → includes bash', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      agent.transitionTo(State.VERIFY);
      expect(toolNames(agent)).toContain('bash');
    });

    it('ANSWER → empty (complete is built separately)', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      agent.transitionTo(State.ANSWER);
      expect(toolNames(agent)).toHaveLength(0);
    });

    it('REVIEW → includes read but NOT bash, edit, write', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      agent.transitionTo(State.REVIEW);
      const names = toolNames(agent);
      expect(names).toContain('read');
      expect(names).not.toContain('bash');
      expect(names).not.toContain('edit');
      expect(names).not.toContain('write');
    });

    it('DIAGNOSE → includes read and bash but NOT edit', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      agent.transitionTo(State.DIAGNOSE);
      const names = toolNames(agent);
      expect(names).toContain('read');
      expect(names).toContain('bash');
      expect(names).not.toContain('edit');
      expect(names).not.toContain('write');
    });

    it('RUN → includes bash but NOT edit', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      agent.transitionTo(State.RUN);
      const names = toolNames(agent);
      expect(names).toContain('bash');
      expect(names).not.toContain('edit');
    });

    it('RESEARCH → includes read', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      agent.transitionTo(State.RESEARCH);
      expect(toolNames(agent)).toContain('read');
    });
  });

  describe('file modification tracking', () => {
    it('canModifyMoreFiles is true initially for SMALL model', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      expect(agent.canModifyMoreFiles()).toBe(true);
    });

    it('tracks edit tool calls', () => {
      const agent = new StateMachineAgent('qwen2.5:7b');
      agent.recordToolCall('edit', { path: 'src/a.ts' }, {});
      expect(agent.canModifyMoreFiles()).toBe(true);
    });

    it('blocks after maxFilesPerTask (2 for SMALL) distinct files edited', () => {
      const agent = new StateMachineAgent('model', [], 7e9);
      agent.recordToolCall('edit', { path: 'src/a.ts' }, {});
      agent.recordToolCall('write', { path: 'src/b.ts' }, {});
      expect(agent.canModifyMoreFiles()).toBe(false);
    });

    it('blocks after 2 edit calls on any files (SMALL, maxFilesPerTask=2)', () => {
      const agent = new StateMachineAgent('model', [], 7e9);
      agent.recordToolCall('edit', { path: 'src/a.ts' }, {});
      agent.recordToolCall('edit', { path: 'src/a.ts' }, {});
      expect(agent.canModifyMoreFiles()).toBe(false);
    });

    it('read calls do not count toward file limit', () => {
      const agent = new StateMachineAgent('model', [], 7e9);
      agent.recordToolCall('read', { path: 'src/a.ts' }, {});
      agent.recordToolCall('read', { path: 'src/b.ts' }, {});
      agent.recordToolCall('read', { path: 'src/c.ts' }, {});
      expect(agent.canModifyMoreFiles()).toBe(true);
    });

    it('LARGE model allows more files', () => {
      const agent = new StateMachineAgent('model', [], 70e9);
      for (let i = 0; i < 5; i++) {
        agent.recordToolCall('edit', { path: `src/file${i}.ts` }, {});
      }
      expect(agent.canModifyMoreFiles()).toBe(true);
    });
  });
});
