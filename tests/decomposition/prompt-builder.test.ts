import { describe, it, expect } from 'vitest';
import { PromptBuilder } from '../../src/decomposition/prompt-builder.js';
import { State } from '../../src/state-machine/types.js';
import type { ModelParams } from '../../src/state-machine/types.js';

const SMALL_PARAMS: ModelParams = {
  tier: 'SMALL',
  paramCount: 7,
  maxFilesPerTask: 2,
  maxRetries: 1,
  strictPlanning: true,
};

const LARGE_PARAMS: ModelParams = {
  tier: 'LARGE',
  paramCount: 70,
  maxFilesPerTask: 8,
  maxRetries: 3,
  strictPlanning: false,
};

describe('PromptBuilder', () => {
  describe('buildSystemPrompt', () => {
    it('includes state name in system prompt', () => {
      const builder = new PromptBuilder();
      const prompt = builder.buildSystemPrompt({ state: State.ANALYZE, task: 'fix bug', modelParams: SMALL_PARAMS });
      expect(prompt).toContain('ANALYZE');
    });

    it('includes task in system prompt', () => {
      const builder = new PromptBuilder();
      const prompt = builder.buildSystemPrompt({ state: State.LOCATE, task: 'find login function', modelParams: SMALL_PARAMS });
      expect(prompt).toContain('find login function');
    });

    it('includes output format guidance', () => {
      const builder = new PromptBuilder();
      const prompt = builder.buildSystemPrompt({ state: State.ANALYZE, task: 'task', modelParams: SMALL_PARAMS });
      expect(prompt).toContain('Output format');
    });

    it('adds small model constraints for SMALL tier', () => {
      const builder = new PromptBuilder();
      const prompt = builder.buildSystemPrompt({ state: State.MODIFY, task: 'task', modelParams: SMALL_PARAMS });
      expect(prompt).toContain('CONSTRAINTS');
    });

    it('does not add small model constraints for LARGE tier', () => {
      const builder = new PromptBuilder();
      const prompt = builder.buildSystemPrompt({ state: State.MODIFY, task: 'task', modelParams: LARGE_PARAMS });
      expect(prompt).not.toContain('CONSTRAINTS');
    });

    it('returns minimal string for DONE state', () => {
      const builder = new PromptBuilder();
      const prompt = builder.buildSystemPrompt({ state: State.DONE, task: 'task', modelParams: SMALL_PARAMS });
      expect(prompt.length).toBeLessThan(30);
    });
  });

  describe('buildUserPrompt', () => {
    it('returns task-specific prompt for ANALYZE state', () => {
      const builder = new PromptBuilder();
      const prompt = builder.buildUserPrompt(State.ANALYZE, 'fix the login bug');
      expect(prompt).toContain('fix the login bug');
      expect(prompt.toLowerCase()).toContain('analyze');
    });

    it('returns task-specific prompt for LOCATE state', () => {
      const builder = new PromptBuilder();
      const prompt = builder.buildUserPrompt(State.LOCATE, 'find auth.ts');
      expect(prompt).toContain('find auth.ts');
    });

    it('returns task-specific prompt for MODIFY state', () => {
      const builder = new PromptBuilder();
      const prompt = builder.buildUserPrompt(State.MODIFY, 'add error handling');
      expect(prompt).toContain('add error handling');
    });

    it('returns task-specific prompt for VERIFY state', () => {
      const builder = new PromptBuilder();
      const prompt = builder.buildUserPrompt(State.VERIFY, 'check the changes');
      expect(prompt).toContain('check the changes');
    });
  });
});
