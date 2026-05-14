import { State, type ModelParams, type StateConfig } from './types.js';

/**
 * Detect model capability tier based on parameter count
 */
export function detectModelParams(modelName: string): ModelParams {
  const match = modelName.match(/(\d+)(?:b|B)/);
  const params = match?.[1] ? parseInt(match[1], 10) : 7;

  if (params <= 7) {
    return {
      tier: 'SMALL',
      paramCount: params,
      maxFilesPerTask: 2,
      maxRetries: 1,
      strictPlanning: true,
    };
  } else if (params <= 30) {
    return {
      tier: 'MEDIUM',
      paramCount: params,
      maxFilesPerTask: 4,
      maxRetries: 2,
      strictPlanning: true,
    };
  } else {
    return {
      tier: 'LARGE',
      paramCount: params,
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
    [State.ANALYZE]: {
      name: State.ANALYZE,
      allowedTools: ['read'],
      prompt: `Analyze the task and understand what needs to be done.
Read relevant files to understand the codebase structure.
Do not write any code yet.

Output your analysis in this format:
1. Task summary
2. Files that need to be modified
3. Approach to implement the changes`,
      maxIterations: 3,
    },
    [State.LOCATE]: {
      name: State.LOCATE,
      allowedTools: ['read', 'grep', 'find', 'ls', 'ast_code_locator'],
      prompt: `Locate the exact positions in the code that need to be modified.
Read the relevant files and identify specific functions, classes, or lines.

Output:
1. File paths and line numbers
2. Current code snippets that will be changed
3. Context around the changes`,
      maxIterations: 5,
    },
    [State.MODIFY]: {
      name: State.MODIFY,
      allowedTools: ['read', 'edit', 'write'],
      prompt: `Make the necessary code changes.
Use edit tool for small changes, write tool for new files.
Always read the file first before editing.

Rules:
1. Make minimal, focused changes
2. Preserve existing code style
3. Do not modify unrelated code`,
      maxIterations: 10,
    },
    [State.VERIFY]: {
      name: State.VERIFY,
      allowedTools: ['read', 'bash'],
      prompt: `Verify the changes are correct.
Run tests, check syntax, review the modifications.

Check:
1. Syntax errors
2. Test results
3. Code review of changes`,
      maxIterations: 3,
    },
    [State.DONE]: {
      name: State.DONE,
      allowedTools: [],
      prompt: 'Task completed.',
      maxIterations: 0,
    },
    [State.REASON]: {
      name: State.REASON,
      allowedTools: [],
      prompt: 'Reason about the task.',
      maxIterations: 1,
    },
    [State.CLARIFY]: {
      name: State.CLARIFY,
      allowedTools: [],
      prompt: 'Ask the user for clarification.',
      maxIterations: 1,
    },
    [State.ANSWER]: {
      name: State.ANSWER,
      allowedTools: [],
      prompt: 'Answer the question directly.',
      maxIterations: 2,
    },
    [State.DIAGNOSE]: {
      name: State.DIAGNOSE,
      allowedTools: ['read', 'grep', 'bash'],
      prompt: 'Diagnose the root cause of the issue.',
      maxIterations: 5,
    },
    [State.REVIEW]: {
      name: State.REVIEW,
      allowedTools: ['read', 'grep'],
      prompt: 'Review the code and provide feedback.',
      maxIterations: 5,
    },
    [State.TEST_WRITE]: {
      name: State.TEST_WRITE,
      allowedTools: ['read', 'write'],
      prompt: 'Write tests for the code.',
      maxIterations: 8,
    },
    [State.REFACTOR_PLAN]: {
      name: State.REFACTOR_PLAN,
      allowedTools: ['read'],
      prompt: 'Plan the refactoring steps.',
      maxIterations: 3,
    },
    [State.ROLLBACK]: {
      name: State.ROLLBACK,
      allowedTools: ['write'],
      prompt: 'Restore files to their previous state.',
      maxIterations: 3,
    },
    [State.RUN]: {
      name: State.RUN,
      allowedTools: ['bash'],
      prompt: 'Execute the requested command and report the result.',
      maxIterations: 5,
    },
    [State.RESEARCH]: {
      name: State.RESEARCH,
      allowedTools: ['webfetch', 'websearch'],
      prompt: 'Research the topic using web search or URL fetch.',
      maxIterations: 5,
    },
    [State.SETUP]: {
      name: State.SETUP,
      allowedTools: ['read', 'bash', 'write'],
      prompt: 'Analyze the project and generate AGENTS.md.',
      maxIterations: 8,
    },
  };
}

/**
 * State transition rules
 */
export function getNextState(currentState: State, _success: boolean): State {
  const transitions: Record<State, State> = {
    [State.ANALYZE]: State.LOCATE,
    [State.LOCATE]: State.MODIFY,
    [State.MODIFY]: State.VERIFY,
    [State.VERIFY]: State.DONE,
    [State.DONE]: State.DONE,
    [State.REASON]: State.ANALYZE,
    [State.CLARIFY]: State.ANALYZE,
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
    case State.ANALYZE:
      return typeof json['summary'] === 'string' && Array.isArray(json['files']);
    case State.LOCATE:
      return Array.isArray(json['locations']);
    case State.MODIFY:
      return typeof json['edited'] === 'string';
    case State.VERIFY:
      return typeof json['passed'] === 'boolean';
    case State.REASON:
      return typeof json['decompose'] === 'boolean';
    case State.CLARIFY:
      return Array.isArray(json['questions']);
    case State.DIAGNOSE:
      return typeof json['rootCause'] === 'string';
    case State.REVIEW:
      return typeof json['verdict'] === 'string';
    case State.TEST_WRITE:
      return typeof json['testFile'] === 'string';
    case State.REFACTOR_PLAN:
      return Array.isArray(json['steps']);
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
