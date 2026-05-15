import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildUserPrompt } from '../../src/core/prompts/index.js';
import { State } from '../../src/core/types.js';
import type { ModelParams } from '../../src/core/types.js';

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

describe('buildSystemPrompt', () => {
  it('includes task in system prompt', () => {
    const prompt = buildSystemPrompt({ state: State.LOCATE, task: 'find login function', modelParams: SMALL_PARAMS });
    expect(prompt).toContain('find login function');
  });

  it('includes coding assistant identity', () => {
    const prompt = buildSystemPrompt({ state: State.LOCATE, task: 'fix bug', modelParams: SMALL_PARAMS });
    expect(prompt.toLowerCase()).toContain('coding assistant');
  });

  it('includes state-specific instruction for LOCATE', () => {
    const prompt = buildSystemPrompt({ state: State.LOCATE, task: 'task', modelParams: SMALL_PARAMS });
    expect(prompt).toContain('complete');
  });

  it('includes state-specific instruction for LOCATE', () => {
    const prompt = buildSystemPrompt({ state: State.LOCATE, task: 'task', modelParams: SMALL_PARAMS });
    expect(prompt).toContain('complete');
  });

  it('adds small model constraints for SMALL tier', () => {
    const prompt = buildSystemPrompt({ state: State.MODIFY, task: 'task', modelParams: SMALL_PARAMS });
    expect(prompt).toContain('400 tokens');
  });

  it('does not add small model constraints for LARGE tier', () => {
    const prompt = buildSystemPrompt({ state: State.MODIFY, task: 'task', modelParams: LARGE_PARAMS });
    expect(prompt).not.toContain('400 tokens');
  });

  it('returns minimal string for DONE state', () => {
    const prompt = buildSystemPrompt({ state: State.DONE, task: 'task', modelParams: SMALL_PARAMS });
    expect(prompt.length).toBeLessThan(30);
  });
});

describe('buildUserPrompt', () => {
  it('returns task for REASON state (default)', () => {
    const prompt = buildUserPrompt(State.REASON, 'fix the login bug');
    expect(prompt).toContain('fix the login bug');
  });

  it('returns task-specific prompt for LOCATE state', () => {
    const prompt = buildUserPrompt(State.LOCATE, 'find auth.ts');
    expect(prompt).toContain('find auth.ts');
  });

  it('returns task-specific prompt for MODIFY state', () => {
    const prompt = buildUserPrompt(State.MODIFY, 'update the handler');
    expect(prompt).toContain('update the handler');
  });

  it('returns task-specific prompt for VERIFY state', () => {
    const prompt = buildUserPrompt(State.VERIFY, 'check the changes');
    expect(prompt).toContain('check the changes');
  });
});
