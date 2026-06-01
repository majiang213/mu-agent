import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildUserPrompt } from '../../src/core/prompts/agent.js';
import { State } from '../../src/core/types.js';
import type { ModelParams } from '../../src/core/types.js';

const SMALL: ModelParams = { tier: 'SMALL', paramCount: 7, maxFilesPerTask: 2, maxRetries: 1, strictPlanning: true };
const LARGE: ModelParams = { tier: 'LARGE', paramCount: 70, maxFilesPerTask: 8, maxRetries: 3, strictPlanning: false };

function prompt(state: State, params: ModelParams = SMALL, extra: Parameters<typeof buildSystemPrompt>[0] = {} as any) {
  return buildSystemPrompt({ state, task: 'test task', modelParams: params, ...extra });
}

describe('buildSystemPrompt', () => {
  describe('base prompt — always present', () => {
    it('includes coding assistant identity', () => {
      const p = prompt(State.REASON);
      expect(p.toLowerCase()).toContain('coding assistant');
    });

    it('includes behavior rules', () => {
      const p = prompt(State.REASON);
      expect(p).toContain('# Behavior');
      expect(p).toContain('# Code changes');
    });

    it('includes task description', () => {
      const p = buildSystemPrompt({ state: State.REASON, task: 'fix the login bug', modelParams: SMALL });
      expect(p).toContain('fix the login bug');
    });

    it('does not include DONE state instruction', () => {
      const p = buildSystemPrompt({ state: State.DONE, task: 'x', modelParams: SMALL });
      expect(p).toBe('Task complete.');
    });
  });

  describe('env block', () => {
    it('includes cwd when env provided', () => {
      const p = buildSystemPrompt({
        state: State.REASON,
        task: 'x',
        modelParams: SMALL,
        env: { cwd: '~/my-project', platform: 'darwin', isGitRepo: true, date: 'Mon Jan 1 2026' },
      });
      expect(p).toContain('~/my-project');
      expect(p).toContain('darwin');
    });

    it('includes project_context block when projectContext provided', () => {
      const p = buildSystemPrompt({
        state: State.REASON,
        task: 'x',
        modelParams: SMALL,
        env: {
          cwd: '~/p',
          platform: 'darwin',
          isGitRepo: true,
          date: 'Mon Jan 1',
          projectContext: { content: '# My Project\n- Use npm test', source: 'AGENTS.md' },
        },
      });
      expect(p).toContain('<project_context source="AGENTS.md">');
      expect(p).toContain('# My Project');
      expect(p).toContain('Use npm test');
    });

    it('project_context block is absent when no projectContext', () => {
      const p = buildSystemPrompt({
        state: State.REASON,
        task: 'x',
        modelParams: SMALL,
        env: { cwd: '~/p', platform: 'darwin', isGitRepo: false, date: 'Mon Jan 1' },
      });
      expect(p).not.toContain('<project_context');
    });

    it('project_context has no truncation marker', () => {
      const p = buildSystemPrompt({
        state: State.REASON,
        task: 'x',
        modelParams: SMALL,
        env: {
          cwd: '~/p',
          platform: 'darwin',
          isGitRepo: true,
          date: 'Mon',
          projectContext: { content: 'x'.repeat(5000), source: 'AGENTS.md' },
        },
      });
      expect(p).not.toContain('[...truncated]');
    });
  });

  describe('SMALL model constraints', () => {
    it('adds 400 token constraint for SMALL model', () => {
      const p = prompt(State.REASON, SMALL);
      expect(p).toContain('400 tokens');
    });

    it('does NOT add 400 token constraint for LARGE model', () => {
      const p = prompt(State.REASON, LARGE);
      expect(p).not.toContain('400 tokens');
    });
  });

  describe('REASON state', () => {
    it('contains complete() call instruction', () => {
      const p = prompt(State.REASON);
      expect(p).toContain('complete(');
    });

    it('contains routing rules for each task type', () => {
      const p = prompt(State.REASON);
      expect(p).toContain('ANSWER');
      expect(p).toContain('LOCATE');
      expect(p).toContain('MODIFY');
      expect(p).toContain('VERIFY');
      expect(p).toContain('RESEARCH');
      expect(p).toContain('REVIEW');
      expect(p).toContain('DIAGNOSE');
    });

    it('contains needsClarify option', () => {
      const p = prompt(State.REASON);
      expect(p).toContain('needsClarify');
    });

    it('contains concrete examples with complete()', () => {
      const p = prompt(State.REASON);
      expect(p).toContain('complete(steps=[{state:"ANSWER"');
    });
  });

  describe('LOCATE state', () => {
    it('contains locate/find instruction', () => {
      const p = prompt(State.LOCATE);
      expect(p.toLowerCase()).toContain('locate');
    });

    it('complete() output schema mentions locations', () => {
      const p = prompt(State.LOCATE);
      expect(p).toContain('complete(');
      expect(p).toContain('locations');
    });
  });

  describe('MODIFY state', () => {
    it('contains edit tool instruction', () => {
      const p = prompt(State.MODIFY);
      expect(p).toContain('edit');
    });

    it('mentions SEARCH/REPLACE semantics', () => {
      const p = prompt(State.MODIFY);
      expect(p).toContain('SEARCH/REPLACE');
    });

    it('mentions oldText must match exactly', () => {
      const p = prompt(State.MODIFY);
      expect(p).toContain('EXACTLY');
    });

    it('complete() output schema mentions edited', () => {
      const p = prompt(State.MODIFY);
      expect(p).toContain('edited');
    });
  });

  describe('VERIFY state', () => {
    it('instructs to run tests', () => {
      const p = prompt(State.VERIFY);
      expect(p.toLowerCase()).toContain('test');
    });

    it('complete() output schema mentions passed', () => {
      const p = prompt(State.VERIFY);
      expect(p).toContain('passed');
    });

    it('contains path audit instruction (Gap 41)', () => {
      const p = prompt(State.VERIFY);
      expect(p).toContain('path audit');
      expect(p).toContain('LOCATE');
      expect(p).toContain('edited');
    });

    it('path audit instructs to skip tests on mismatch', () => {
      const p = prompt(State.VERIFY);
      expect(p).toContain('wrong location');
      expect(p).toContain('skip tests');
    });
  });

  describe('ANSWER state', () => {
    it('instructs to answer directly', () => {
      const p = prompt(State.ANSWER);
      expect(p.toLowerCase()).toContain('answer');
    });

    it('complete() output schema mentions answer field', () => {
      const p = prompt(State.ANSWER);
      expect(p).toContain('complete(answer=');
    });
  });

  describe('REVIEW state', () => {
    it('explicitly lists available tools', () => {
      const p = prompt(State.REVIEW);
      expect(p).toContain('Available tools');
      expect(p).toContain('read');
      expect(p).toContain('grep');
      expect(p).toContain('complete');
    });

    it('says do NOT modify', () => {
      const p = prompt(State.REVIEW);
      expect(p.toUpperCase()).toContain('NOT MODIFY');
    });

    it('complete() output schema mentions issues and verdict', () => {
      const p = prompt(State.REVIEW);
      expect(p).toContain('issues');
      expect(p).toContain('verdict');
    });
  });

  describe('RESEARCH state', () => {
    it('explicitly lists available tools', () => {
      const p = prompt(State.RESEARCH);
      expect(p).toContain('Available tools');
      expect(p).toContain('webfetch');
      expect(p).toContain('websearch');
    });

    it('says do NOT modify files', () => {
      const p = prompt(State.RESEARCH);
      expect(p.toUpperCase()).toContain('NOT MODIFY');
    });
  });

  describe('DIAGNOSE state', () => {
    it('instructs not to modify', () => {
      const p = prompt(State.DIAGNOSE);
      expect(p.toUpperCase()).toContain('NOT MODIFY');
    });

    it('complete() output schema mentions rootCause', () => {
      const p = prompt(State.DIAGNOSE);
      expect(p).toContain('rootCause');
    });
  });

  describe('RUN state', () => {
    it('instructs to use bash', () => {
      const p = prompt(State.RUN);
      expect(p).toContain('bash');
    });

    it('instructs not to modify files', () => {
      const p = prompt(State.RUN);
      expect(p.toUpperCase()).toContain('NOT MODIFY');
    });

    it('complete() output schema mentions exitCode', () => {
      const p = prompt(State.RUN);
      expect(p).toContain('exitCode');
    });
  });

  describe('SETUP state', () => {
    it('instructs to generate AGENTS.md', () => {
      const p = prompt(State.SETUP);
      expect(p).toContain('AGENTS.md');
    });
  });

  describe('REFACTOR_PLAN state', () => {
    it('explicitly lists available tools', () => {
      const p = prompt(State.REFACTOR_PLAN);
      expect(p).toContain('Available tools');
      expect(p).toContain('read');
      expect(p).toContain('complete');
    });

    it('says do NOT modify', () => {
      const p = prompt(State.REFACTOR_PLAN);
      expect(p.toUpperCase()).toContain('NOT');
    });
  });
});

describe('buildUserPrompt', () => {
  it('LOCATE returns locate-specific prompt', () => {
    const p = buildUserPrompt(State.LOCATE, 'fix auth', 'find login function');
    expect(p).toContain('find login function');
    expect(p.toLowerCase()).toContain('locate');
  });

  it('MODIFY returns modify-specific prompt', () => {
    const p = buildUserPrompt(State.MODIFY, 'fix auth', 'add null check');
    expect(p).toContain('add null check');
  });

  it('VERIFY returns verify-specific prompt', () => {
    const p = buildUserPrompt(State.VERIFY, 'fix auth', 'run tests');
    expect(p.toLowerCase()).toContain('verify');
  });

  it('defaults to focus when provided', () => {
    const p = buildUserPrompt(State.ANSWER, 'what is X', 'explain X in detail');
    expect(p).toContain('explain X in detail');
  });

  it('falls back to task when no focus', () => {
    const p = buildUserPrompt(State.ANSWER, 'what is X');
    expect(p).toContain('what is X');
  });

  it('MODIFY injects DIAGNOSE result from previousResults', () => {
    const prev = [
      {
        state: State.DIAGNOSE,
        focus: 'why tests fail',
        output: '{"rootCause":"divide has no zero guard","location":"calc.js:5","fix":"add if b===0 throw"}',
      },
    ];
    const p = buildUserPrompt(State.MODIFY, 'fix calc.js', 'add zero-check guard', prev);
    expect(p).toContain('previous_step_results');
    expect(p).toContain('DIAGNOSE');
    expect(p).toContain('divide has no zero guard');
  });

  it('MODIFY injects LOCATE result from previousResults', () => {
    const prev = [
      {
        state: State.LOCATE,
        focus: 'find divide function',
        output: '{"locations":[{"file":"calc.js","startLine":5,"endLine":7}]}',
      },
    ];
    const p = buildUserPrompt(State.MODIFY, 'fix calc.js', 'add zero-check', prev);
    expect(p).toContain('previous_step_results');
    expect(p).toContain('LOCATE');
  });

  it('MODIFY skips irrelevant states from previousResults', () => {
    const prev = [{ state: State.VERIFY, focus: 'run tests', output: '{"passed":false}' }];
    const p = buildUserPrompt(State.MODIFY, 'fix calc.js', 'add zero-check', prev);
    expect(p).not.toContain('previous_step_results');
  });

  it('VERIFY injects MODIFY result from previousResults', () => {
    const prev = [{ state: State.MODIFY, focus: 'add zero-check', output: '{"edited":["calc.js"],"linesChanged":2}' }];
    const p = buildUserPrompt(State.VERIFY, 'fix calc.js', 'run npm test', prev);
    expect(p).toContain('previous_step_results');
    expect(p).toContain('MODIFY');
  });

  it('VERIFY injects LOCATE result from previousResults (Gap 41 path audit)', () => {
    const prev = [
      {
        state: State.LOCATE,
        focus: 'find divide function',
        output: '{"locations":[{"file":"calc.js","startLine":5,"endLine":7}]}',
      },
      { state: State.MODIFY, focus: 'add zero-check', output: '{"edited":["calc.js"],"linesChanged":1}' },
    ];
    const p = buildUserPrompt(State.VERIFY, 'fix calc.js', 'run tests', prev);
    expect(p).toContain('previous_step_results');
    expect(p).toContain('LOCATE');
    expect(p).toContain('MODIFY');
    expect(p).toContain('calc.js');
  });

  it('VERIFY injects DIAGNOSE result from previousResults (Gap 41 path audit)', () => {
    const prev = [
      {
        state: State.DIAGNOSE,
        focus: 'why divide fails',
        output: '{"rootCause":"no zero guard","location":"calc.js:5","fix":"add throw"}',
      },
      { state: State.MODIFY, focus: 'add zero-check', output: '{"edited":["calc.js"],"linesChanged":1}' },
    ];
    const p = buildUserPrompt(State.VERIFY, 'fix calc.js', 'run tests', prev);
    expect(p).toContain('previous_step_results');
    expect(p).toContain('DIAGNOSE');
    expect(p).toContain('MODIFY');
  });

  it('VERIFY skips LOCATE-only previousResults when no MODIFY present', () => {
    const prev = [
      {
        state: State.LOCATE,
        focus: 'find divide function',
        output: '{"locations":[{"file":"calc.js","startLine":5}]}',
      },
    ];
    const p = buildUserPrompt(State.VERIFY, 'fix calc.js', 'run tests', prev);
    expect(p).toContain('previous_step_results');
    expect(p).toContain('LOCATE');
  });

  it('LOCATE injects RESEARCH result from previousResults', () => {
    const prev = [
      {
        state: State.RESEARCH,
        focus: 'read calc.js',
        output: '{"report":"found 2 bugs: divide zero + average empty"}',
      },
    ];
    const p = buildUserPrompt(State.LOCATE, 'fix calc.js', 'find divide fn', prev);
    expect(p).toContain('previous_step_results');
    expect(p).toContain('RESEARCH');
    expect(p).toContain('found 2 bugs');
  });

  it('LOCATE injects DIAGNOSE result from previousResults', () => {
    const prev = [
      { state: State.DIAGNOSE, focus: 'why fail', output: '{"rootCause":"no zero guard","location":"calc.js:5"}' },
    ];
    const p = buildUserPrompt(State.LOCATE, 'fix calc.js', 'find divide fn', prev);
    expect(p).toContain('previous_step_results');
    expect(p).toContain('DIAGNOSE');
  });

  it('LOCATE skips irrelevant states (e.g. VERIFY)', () => {
    const prev = [{ state: State.VERIFY, focus: 'run tests', output: '{"passed":false}' }];
    const p = buildUserPrompt(State.LOCATE, 'fix calc.js', 'find divide fn', prev);
    expect(p).not.toContain('previous_step_results');
  });

  it('MODIFY injects RESEARCH result from previousResults (Gap 46)', () => {
    const prev = [
      {
        state: State.RESEARCH,
        focus: 'read calc.js',
        output: '{"report":"bug 1: divide zero. bug 2: average empty array"}',
      },
    ];
    const p = buildUserPrompt(State.MODIFY, 'fix calc.js', 'fix bugs', prev);
    expect(p).toContain('previous_step_results');
    expect(p).toContain('RESEARCH');
    expect(p).toContain('bug 1: divide zero');
  });

  it('ROLLBACK injects MODIFY result from previousResults', () => {
    const prev = [
      { state: State.MODIFY, focus: 'add zero-check', output: '{"edited":["calc.js","utils.js"],"linesChanged":3}' },
    ];
    const p = buildUserPrompt(State.ROLLBACK, 'fix calc.js', 'restore files', prev);
    expect(p).toContain('previous_step_results');
    expect(p).toContain('MODIFY');
    expect(p).toContain('calc.js');
  });

  it('ROLLBACK injects LOCATE result from previousResults', () => {
    const prev = [
      { state: State.LOCATE, focus: 'find divide fn', output: '{"locations":[{"file":"calc.js","startLine":5}]}' },
      { state: State.MODIFY, focus: 'add zero-check', output: '{"edited":["calc.js"],"linesChanged":2}' },
    ];
    const p = buildUserPrompt(State.ROLLBACK, 'fix calc.js', 'restore files', prev);
    expect(p).toContain('MODIFY');
    expect(p).toContain('LOCATE');
  });

  it('TEST_WRITE injects RESEARCH and LOCATE results', () => {
    const prev = [
      { state: State.RESEARCH, focus: 'read calc.js', output: '{"report":"divide has no zero guard"}' },
      { state: State.LOCATE, focus: 'find divide fn', output: '{"locations":[{"file":"calc.js","startLine":5}]}' },
    ];
    const p = buildUserPrompt(State.TEST_WRITE, 'write tests for calc.js', 'cover edge cases', prev);
    expect(p).toContain('previous_step_results');
    expect(p).toContain('RESEARCH');
    expect(p).toContain('LOCATE');
  });

  it('default state (non-switch) injects context when available', () => {
    const prev = [{ state: State.RESEARCH, focus: 'read code', output: '{"report":"findings"}' }];
    const p = buildUserPrompt(State.REFACTOR_PLAN, 'refactor auth', 'plan steps', prev);
    expect(p).toContain('previous_step_results');
    expect(p).toContain('RESEARCH');
  });

  it('truncates long outputs to 600 chars', () => {
    const longOutput = 'x'.repeat(1000);
    const prev = [{ state: State.DIAGNOSE, focus: 'diag', output: longOutput }];
    const p = buildUserPrompt(State.MODIFY, 'fix', 'apply', prev);
    expect(p).toContain('previous_step_results');
    expect(p.length).toBeLessThan(longOutput.length + 500);
  });

  it('no previousResults arg — no injection', () => {
    const p = buildUserPrompt(State.MODIFY, 'fix calc.js', 'add zero-check');
    expect(p).not.toContain('previous_step_results');
  });
});

describe('base prompt — new rules from opencode comparison', () => {
  it('says NEVER commit unless explicitly asked', () => {
    const p = prompt(State.REASON);
    expect(p.toUpperCase()).toContain('NEVER COMMIT');
  });

  it('says stop after completing, no explanation', () => {
    const p = prompt(State.REASON);
    expect(p.toLowerCase()).toContain('after completing');
  });

  it('says never assume a library is available', () => {
    const p = prompt(State.REASON);
    expect(p.toUpperCase()).toContain('NEVER ASSUME');
  });
});

describe('base prompt — new rules from opencode+pi comparison (round 2)', () => {
  it('mentions file:line reference format', () => {
    const p = prompt(State.REASON);
    expect(p).toContain('file_path:line_number');
  });

  it('says explain bash command before running', () => {
    const p = prompt(State.REASON);
    expect(p.toLowerCase()).toContain('non-trivial bash');
  });

  it('says NEVER add comments unless asked', () => {
    const p = prompt(State.REASON);
    expect(p.toUpperCase()).toContain('NEVER ADD COMMENTS');
  });

  it('says NEVER write secrets or API keys', () => {
    const p = prompt(State.REASON);
    expect(p.toUpperCase()).toContain('NEVER WRITE SECRETS');
  });

  it('says prefer grep/find/ls over bash for file exploration', () => {
    const p = prompt(State.REASON);
    expect(p.toLowerCase()).toContain('grep/find/ls');
  });

  it('says run lint and typecheck after code change', () => {
    const p = prompt(State.REASON);
    expect(p.toLowerCase()).toContain('lint');
    expect(p.toLowerCase()).toContain('typecheck');
  });
});

describe('ANSWER state — no tools', () => {
  it('says do NOT use any tools', () => {
    const p = prompt(State.ANSWER);
    expect(p.toUpperCase()).toContain('DO NOT USE ANY TOOLS');
  });

  it('contains example with complete(answer=...)', () => {
    const p = prompt(State.ANSWER);
    expect(p).toContain('complete(answer=');
  });
});

describe('LOCATE state — tools and parallel', () => {
  it('lists available tools: read, ast_code_locator, complete', () => {
    const p = prompt(State.LOCATE);
    expect(p).toContain('Available tools');
    expect(p).toContain('read');
    expect(p).toContain('ast_code_locator');
    expect(p).toContain('complete');
  });

  it('does NOT list grep/find/ls in Available tools — BM25 already handles file discovery', () => {
    const p = prompt(State.LOCATE);
    const toolsLine = p.match(/Available tools:[^\n]*/)?.[0] ?? '';
    expect(toolsLine).not.toMatch(/\bgrep\b/);
    expect(toolsLine).not.toMatch(/\bfind\b/);
    expect(toolsLine).not.toMatch(/\bls\b/);
  });

  it('mentions suggested_files from BM25 pre-processing', () => {
    const p = prompt(State.LOCATE);
    expect(p).toContain('suggested_files');
  });

  it('contains example block', () => {
    const p = prompt(State.LOCATE);
    expect(p).toContain('<example>');
  });
});

describe('DIAGNOSE state — tools and example', () => {
  it('lists available tools including bash', () => {
    const p = prompt(State.DIAGNOSE);
    expect(p).toContain('Available tools');
    expect(p).toContain('bash');
    expect(p).toContain('grep');
  });

  it('mentions parallel tool calls', () => {
    const p = prompt(State.DIAGNOSE);
    expect(p.toLowerCase()).toContain('parallel');
  });

  it('contains example block', () => {
    const p = prompt(State.DIAGNOSE);
    expect(p).toContain('<example>');
  });
});

describe('VERIFY state — no misleading type-skip instruction', () => {
  it('does NOT say to skip type checking', () => {
    const p = prompt(State.VERIFY);
    expect(p.toLowerCase()).not.toContain('do not re-check');
  });

  it('says to check for build/typecheck command', () => {
    const p = prompt(State.VERIFY);
    expect(p.toLowerCase()).toContain('build');
  });

  it('contains example block', () => {
    const p = prompt(State.VERIFY);
    expect(p).toContain('<example>');
  });
});

describe('MODIFY state — understand before change', () => {
  it('says to read file first for code style', () => {
    const p = prompt(State.MODIFY);
    expect(p.toLowerCase()).toContain('code style');
  });

  it('says never assume a library is available', () => {
    const p = prompt(State.MODIFY);
    expect(p.toUpperCase()).toContain('NEVER ASSUME');
  });

  it('contains example block', () => {
    const p = prompt(State.MODIFY);
    expect(p).toContain('<example>');
  });
});

describe('RESEARCH/REVIEW/REFACTOR_PLAN — parallel tool hints', () => {
  it('RESEARCH mentions parallel', () => {
    const p = prompt(State.RESEARCH);
    expect(p.toLowerCase()).toContain('parallel');
  });

  it('RESEARCH contains example for local code', () => {
    const p = prompt(State.RESEARCH);
    expect(p).toContain('<example>');
    expect(p).toContain('webfetch');
  });

  it('REVIEW mentions parallel', () => {
    const p = prompt(State.REVIEW);
    expect(p.toLowerCase()).toContain('parallel');
  });

  it('REFACTOR_PLAN now lists grep tool', () => {
    const p = prompt(State.REFACTOR_PLAN);
    expect(p).toContain('grep');
  });
});

describe('REASON — all routing branches have examples', () => {
  it('has example for explain/research', () => {
    const p = prompt(State.REASON);
    expect(p).toContain('Explain code');
  });

  it('has example for web search', () => {
    const p = prompt(State.REASON);
    expect(p).toContain('Web search');
  });

  it('has example for review', () => {
    const p = prompt(State.REASON);
    expect(p).toContain('Review code');
  });

  it('has example for simple edit', () => {
    const p = prompt(State.REASON);
    expect(p).toContain('Simple edit');
  });

  it('has example for bug investigation with DIAGNOSE', () => {
    const p = prompt(State.REASON);
    expect(p).toContain('Investigate');
    expect(p).toContain('DIAGNOSE');
  });

  it('has example for run command', () => {
    const p = prompt(State.REASON);
    expect(p).toContain('Run command');
  });

  it('has example for setup', () => {
    const p = prompt(State.REASON);
    expect(p).toContain('Setup');
    expect(p).toContain('SETUP');
  });

  it('has example for retry after VERIFY failure', () => {
    const p = prompt(State.REASON);
    expect(p).toContain('Retry after VERIFY failure');
    expect(p).toContain('ROLLBACK');
  });

  it('has example for accepting failure (cannot fix)', () => {
    const p = prompt(State.REASON);
    expect(p).toContain('Accept failure');
  });
});

describe('REVIEW — has example', () => {
  it('contains example block', () => {
    const p = prompt(State.REVIEW);
    expect(p).toContain('<example>');
  });

  it('example shows parallel reads', () => {
    const p = prompt(State.REVIEW);
    expect(p).toContain('parallel');
  });
});

describe('TEST_WRITE — tools and example', () => {
  it('lists available tools', () => {
    const p = prompt(State.TEST_WRITE);
    expect(p).toContain('Available tools');
    expect(p).toContain('read');
    expect(p).toContain('write');
    expect(p).toContain('complete');
  });

  it('says do NOT modify business logic files', () => {
    const p = prompt(State.TEST_WRITE);
    expect(p.toUpperCase()).toContain('NOT MODIFY');
  });

  it('contains example block', () => {
    const p = prompt(State.TEST_WRITE);
    expect(p).toContain('<example>');
  });
});

describe('ROLLBACK — tools and example', () => {
  it('lists available tools', () => {
    const p = prompt(State.ROLLBACK);
    expect(p).toContain('Available tools');
    expect(p).toContain('read');
    expect(p).toContain('write');
    expect(p).toContain('complete');
  });

  it('contains example block', () => {
    const p = prompt(State.ROLLBACK);
    expect(p).toContain('<example>');
  });
});

describe('CLARIFY — one tool + example', () => {
  it('says only complete() tool available', () => {
    const p = prompt(State.CLARIFY);
    expect(p).toContain('ONE tool');
    expect(p).toContain('complete()');
  });

  it('says maximum 3 questions', () => {
    const p = prompt(State.CLARIFY);
    expect(p).toContain('3 questions');
  });

  it('contains example block', () => {
    const p = prompt(State.CLARIFY);
    expect(p).toContain('<example>');
  });
});

describe('RUN — tools and example', () => {
  it('lists available tools', () => {
    const p = prompt(State.RUN);
    expect(p).toContain('Available tools');
    expect(p).toContain('bash');
    expect(p).toContain('complete');
  });

  it('contains example block', () => {
    const p = prompt(State.RUN);
    expect(p).toContain('<example>');
  });
});

describe('SETUP — tools and example', () => {
  it('lists available tools including write', () => {
    const p = prompt(State.SETUP);
    expect(p).toContain('Available tools');
    expect(p).toContain('read');
    expect(p).toContain('write');
    expect(p).toContain('ls');
  });

  it('mentions parallel reads', () => {
    const p = prompt(State.SETUP);
    expect(p.toLowerCase()).toContain('parallel');
  });

  it('contains example block', () => {
    const p = prompt(State.SETUP);
    expect(p).toContain('<example>');
  });
});

describe('REFACTOR_PLAN — example', () => {
  it('contains example block', () => {
    const p = prompt(State.REFACTOR_PLAN);
    expect(p).toContain('<example>');
  });
});

describe('SMALL_MODEL_CONSTRAINTS — REASON vs other states', () => {
  it('REASON state does NOT include "listed tools" phrase', () => {
    const p = prompt(State.REASON, SMALL);
    expect(p).not.toContain('listed tools');
  });

  it('LOCATE state includes "listed tools" phrase', () => {
    const p = prompt(State.LOCATE, SMALL);
    expect(p).toContain('listed tools');
  });

  it('both REASON and LOCATE include 400 token constraint', () => {
    expect(prompt(State.REASON, SMALL)).toContain('400 tokens');
    expect(prompt(State.LOCATE, SMALL)).toContain('400 tokens');
  });
});
