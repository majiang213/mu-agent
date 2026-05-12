import { State, type ModelParams, type StateContext } from '../core/types.js';

export interface PromptOptions {
  state: State;
  task: string;
  modelParams: ModelParams;
  context?: StateContext;
}

const STATE_GOALS: Record<State, string> = {
  [State.ANALYZE]: 'understand the task and identify files to change',
  [State.LOCATE]: 'find exact file paths and line numbers to modify',
  [State.MODIFY]: 'apply minimal, focused code changes',
  [State.VERIFY]: 'confirm changes are correct and tests pass',
  [State.DONE]: 'task is complete',
};

const STATE_OUTPUT_FORMAT: Record<State, string> = {
  [State.ANALYZE]: `Output format (JSON):
{"summary": "<one sentence>", "files": ["<path>", ...], "approach": "<how to implement>"}`,
  [State.LOCATE]: `Output format (JSON):
{"locations": [{"file": "<path>", "startLine": <n>, "endLine": <n>, "snippet": "<code>"}]}`,
  [State.MODIFY]: `Output format: use tools directly. After each edit, output:
{"edited": "<file>", "linesChanged": <n>}`,
  [State.VERIFY]: `Output format (JSON):
{"passed": true|false, "issues": ["<issue>", ...], "summary": "<result>"}`,
  [State.DONE]: '',
};

const STATE_EXAMPLES: Partial<Record<State, string>> = {
  [State.ANALYZE]: `Example:
User: "Add error handling to the login function"
Output: {"summary": "Add try/catch to login() in auth.ts", "files": ["src/auth.ts"], "approach": "Wrap the body of login() in try/catch, throw AuthError on failure"}`,
  [State.LOCATE]: `Example:
User: "Find the login function"
Output: {"locations": [{"file": "src/auth.ts", "startLine": 42, "endLine": 58, "snippet": "async function login(user, pass) {"}]}`,
  [State.MODIFY]: `Example: read the file first, then use edit tool to change only the target lines.`,
  [State.VERIFY]: `Example:
After editing src/auth.ts: run bash "npx tsc --noEmit" then check output.
Output: {"passed": true, "issues": [], "summary": "No type errors"}`,
};

const SMALL_MODEL_CONSTRAINTS = `
CONSTRAINTS (small model mode — follow strictly):
- Respond in under 400 tokens
- Use only the listed tools
- Do not speculate — only report what you observe
- If unsure, output {"error": "<what is unclear>"} and stop`;

export class PromptBuilder {
  buildSystemPrompt(options: PromptOptions): string {
    const { state, task, modelParams, context } = options;

    if (state === State.DONE) {
      return 'Task complete.';
    }

    const goal = STATE_GOALS[state];
    const outputFormat = STATE_OUTPUT_FORMAT[state];
    const example = STATE_EXAMPLES[state] ?? '';

    const toolList = context?.availableTools?.length
      ? `Available tools: ${context.availableTools.map((t) => t.name).join(', ')}`
      : '';

    const lines = [
      `You are a coding assistant. Current state: ${state}. Goal: ${goal}.`,
      '',
      `Task: ${task}`,
      '',
      toolList,
      '',
      outputFormat,
      '',
      example,
    ];

    if (modelParams.tier === 'SMALL') {
      lines.push(SMALL_MODEL_CONSTRAINTS);
    }

    return lines.filter((l) => l !== undefined).join('\n').trim();
  }

  buildUserPrompt(state: State, task: string): string {
    switch (state) {
      case State.ANALYZE:
        return `Analyze this task and output your plan as JSON: ${task}`;
      case State.LOCATE:
        return `Locate the exact code positions for: ${task}`;
      case State.MODIFY:
        return `Apply the changes for: ${task}`;
      case State.VERIFY:
        return `Verify the changes are correct for: ${task}`;
      default:
        return task;
    }
  }
}
