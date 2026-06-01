import { State, type ModelParams, type StateConfig } from './types.js';

export function detectModelParams(paramCount: number | null): ModelParams {
  const billions = paramCount !== null ? paramCount / 1e9 : null;

  if (billions !== null && billions <= 9) {
    return {
      tier: 'SMALL',
      paramCount: billions,
      maxFilesPerTask: 2,
      maxRetries: 1,
      strictPlanning: true,
    };
  } else if (billions !== null && billions <= 30) {
    return {
      tier: 'MEDIUM',
      paramCount: billions,
      maxFilesPerTask: 4,
      maxRetries: 2,
      strictPlanning: true,
    };
  } else {
    return {
      tier: 'LARGE',
      paramCount: billions ?? 0,
      maxFilesPerTask: 8,
      maxRetries: 3,
      strictPlanning: false,
    };
  }
}

/**
 * Get base state configurations
 */
export function getBaseStateConfigs(): Record<State, StateConfig> {
  return {
    [State.LOCATE]: {
      name: State.LOCATE,
      allowedTools: ['read', 'ast_code_locator', 'complete'],
      prompt: `Locate the exact positions in the code that need to be modified.
Read the relevant files and identify specific functions, classes, or lines.

Output:
1. File paths and line numbers
2. Current code snippets that will be changed
3. Context around the changes`,
    },
    [State.MODIFY]: {
      name: State.MODIFY,
      allowedTools: ['read', 'edit', 'write', 'complete'],
      prompt: `Make the necessary code changes.
Use edit tool for small changes, write tool for new files.
Always read the file first before editing.

Rules:
1. Make minimal, focused changes
2. Preserve existing code style
3. Do not modify unrelated code`,
    },
    [State.VERIFY]: {
      name: State.VERIFY,
      allowedTools: ['read', 'bash', 'complete'],
      prompt: `Verify the changes are correct.
Run tests, check syntax, review the modifications.

Check:
1. Syntax errors
2. Test results
3. Code review of changes`,
    },
    [State.DONE]: {
      name: State.DONE,
      allowedTools: [],
      prompt: 'Task completed.',
    },
    [State.REASON]: {
      name: State.REASON,
      allowedTools: ['complete'],
      prompt: 'Reason about the task.',
    },
    [State.CLARIFY]: {
      name: State.CLARIFY,
      allowedTools: ['complete'],
      prompt: 'Ask the user for clarification.',
    },
    [State.ANSWER]: {
      name: State.ANSWER,
      allowedTools: ['complete'],
      prompt: 'Answer the question directly.',
    },
    [State.DIAGNOSE]: {
      name: State.DIAGNOSE,
      allowedTools: ['read', 'grep', 'bash', 'complete'],
      prompt: 'Diagnose the root cause of the issue.',
    },
    [State.REVIEW]: {
      name: State.REVIEW,
      allowedTools: ['read', 'grep', 'complete'],
      prompt: 'Review the code and provide feedback.',
    },
    [State.TEST_WRITE]: {
      name: State.TEST_WRITE,
      allowedTools: ['read', 'write', 'complete'],
      prompt: 'Write tests for the code.',
    },
    [State.REFACTOR_PLAN]: {
      name: State.REFACTOR_PLAN,
      allowedTools: ['read', 'complete'],
      prompt: 'Plan the refactoring steps.',
    },
    [State.ROLLBACK]: {
      name: State.ROLLBACK,
      allowedTools: ['read', 'write', 'complete'],
      prompt: 'Restore files to their previous state.',
    },
    [State.RUN]: {
      name: State.RUN,
      allowedTools: ['bash', 'complete'],
      prompt: 'Execute the requested command and report the result.',
    },
    [State.RESEARCH]: {
      name: State.RESEARCH,
      allowedTools: ['read', 'grep', 'find', 'ls', 'webfetch', 'websearch', 'complete'],
      prompt: 'Research and investigate the topic. Read local files or search the web as needed.',
    },
    [State.SETUP]: {
      name: State.SETUP,
      allowedTools: ['read', 'bash', 'write', 'complete'],
      prompt: 'Analyze the project and generate AGENTS.md.',
    },
  };
}

/**
 * State transition rules
 */
export function getNextState(currentState: State, _success: boolean): State {
  const transitions: Record<State, State> = {
    [State.LOCATE]: State.MODIFY,
    [State.MODIFY]: State.VERIFY,
    [State.VERIFY]: State.DONE,
    [State.DONE]: State.DONE,
    [State.REASON]: State.LOCATE,
    [State.CLARIFY]: State.LOCATE,
    [State.ANSWER]: State.DONE,
    [State.DIAGNOSE]: State.LOCATE,
    [State.REVIEW]: State.DONE,
    [State.TEST_WRITE]: State.VERIFY,
    [State.REFACTOR_PLAN]: State.LOCATE,
    [State.ROLLBACK]: State.DONE,
    [State.RUN]: State.DONE,
    [State.RESEARCH]: State.DONE,
    [State.SETUP]: State.DONE,
  };

  return transitions[currentState];
}

// ─── State completion detection ───────────────────────────────────────────────

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Check whether the LLM output contains the expected JSON for the current state.
 * Used to drive state advancement deterministically.
 */
export function hasStateCompletionJson(state: State, text: string): boolean {
  const json = extractJson(text);
  if (!json) return false;
  switch (state) {
    case State.LOCATE:
      return Array.isArray(json['locations']);
    case State.MODIFY:
      return typeof json['edited'] === 'string';
    case State.VERIFY:
      return typeof json['passed'] === 'boolean';
    case State.REASON: {
      const steps = json['steps'];
      const needsClarify = json['needsClarify'] === true;
      return Array.isArray(steps) && (needsClarify || (steps as unknown[]).length > 0);
    }
    case State.CLARIFY:
      return Array.isArray(json['questions']);
    case State.DIAGNOSE:
      return typeof json['rootCause'] === 'string';
    case State.REVIEW:
      return typeof json['verdict'] === 'string';
    case State.TEST_WRITE:
      return typeof json['testFile'] === 'string';
    case State.REFACTOR_PLAN:
      return Array.isArray(json['refactorSteps']);
    case State.RUN:
      return typeof json['exitCode'] === 'number';
    case State.SETUP:
      return typeof json['created'] === 'string';
    case State.ANSWER:
    case State.RESEARCH:
      return false;
    default:
      return false;
  }
}

export function advanceState(current: State, route: State[]): State {
  const idx = route.indexOf(current);
  return idx >= 0 && idx < route.length - 1 ? route[idx + 1]! : State.DONE;
}
