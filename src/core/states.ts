import { State, type ModelParams, type ModelTier, type StateConfig } from './types.js';

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
  };
}

/**
 * Generate adaptive prompt based on model tier
 */
export function generateAdaptivePrompt(
  basePrompt: string,
  modelParams: ModelParams,
  currentFileCount: number,
): string {
  if (modelParams.tier === 'SMALL') {
    const constraints = `

IMPORTANT CONSTRAINTS (Small Model Mode):
- Maximum ${modelParams.maxFilesPerTask} files can be modified in this task
- Already modified: ${currentFileCount} files
- Must read file content before editing
- If verification fails, retry up to ${modelParams.maxRetries} times
- Keep changes minimal and focused`;
    return basePrompt + constraints;
  }

  return basePrompt;
}

/**
 * State transition rules
 */
export function getNextState(currentState: State, success: boolean): State {
  const transitions: Record<State, State> = {
    [State.ANALYZE]: State.LOCATE,
    [State.LOCATE]: State.MODIFY,
    [State.MODIFY]: State.VERIFY,
    [State.VERIFY]: State.DONE,
    [State.DONE]: State.DONE,
  };

  return transitions[currentState];
}
