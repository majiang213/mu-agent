import { State, type ModelParams, type StateContext } from '../types.js';

export interface SystemPromptOptions {
  state: State;
  task: string;
  modelParams: ModelParams;
  context?: StateContext;
}

const BASE_PROMPT = `You are an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.

You can answer questions, have conversations, and assist with any coding task. Use tools when needed — otherwise reply directly.`;

const STATE_INSTRUCTIONS: Partial<Record<State, string>> = {
  [State.REASON]: `Analyze the user input. Determine if it contains multiple independent tasks and whether clarification is needed.
Output JSON: {"decompose": true|false, "type": "CODING|BUGFIX|REFACTORING|TESTING|DOCUMENTATION|REVIEW|ANALYSIS|QUESTION|UNKNOWN", "needsClarify": true|false}
- decompose=true: input contains multiple tasks (do NOT list them, just set the flag)
- decompose=false: single task, set type accordingly
- needsClarify=true: task description is ambiguous and needs user input before proceeding`,

  [State.CLARIFY]: `The task description is ambiguous. List the specific pieces of information needed from the user.
Output JSON: {"questions": ["<question1>", "<question2>", ...]}
Keep questions concise and specific. Maximum 3 questions.`,

  [State.ANALYZE]: `When given a coding task, identify what needs to change and output a brief plan as JSON:
{"summary": "<one sentence>", "files": ["<path>", ...], "approach": "<how to implement>"}`,

  [State.LOCATE]: `Locate the exact file paths and line numbers that need to be modified. Output JSON:
{"locations": [{"file": "<path>", "startLine": <n>, "endLine": <n>, "snippet": "<code>"}]}`,

  [State.MODIFY]: `Apply minimal, focused code changes using the edit or write tools. After each change output:
{"edited": "<file>", "linesChanged": <n>}`,

  [State.VERIFY]: `Verify the changes are correct. Run type checks or tests if available. Output JSON:
{"passed": true|false, "issues": ["<issue>", ...], "summary": "<result>"}`,

  [State.ANSWER]: `Answer the question directly and thoroughly. No tools needed. Reply in plain text.`,

  [State.DIAGNOSE]: `Investigate the root cause of the issue. Read files, search code, run read-only commands.
Output JSON: {"rootCause": "<explanation>", "location": "<file:line>", "fix": "<suggested fix>"}`,

  [State.REVIEW]: `Review the code for quality, correctness, and potential issues. Read files only.
Output JSON: {"issues": ["<issue>", ...], "suggestions": ["<suggestion>", ...], "verdict": "pass|fail"}`,

  [State.TEST_WRITE]: `Write tests for the specified code. Do not modify business logic files.
Output JSON: {"testFile": "<path>", "cases": <number of test cases>}`,

  [State.REFACTOR_PLAN]: `Plan the refactoring steps without making any changes yet. Read files to understand scope.
Output JSON: {"steps": ["<step1>", ...], "estimatedFiles": <n>}`,

  [State.ROLLBACK]: `Restore the modified files to their previous state using the write tool.
Output JSON: {"restored": ["<file1>", ...]}`,
};

const SMALL_MODEL_CONSTRAINTS = `Keep responses concise (under 400 tokens). Only use the listed tools. Do not speculate.`;

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const { state, task, modelParams, context } = options;

  if (state === State.DONE) {
    return 'Task complete.';
  }

  const toolList = context?.availableTools?.length
    ? `Available tools:\n${context.availableTools.map((t) => `- ${t.name}`).join('\n')}`
    : '';

  const stateInstruction = STATE_INSTRUCTIONS[state] ?? '';

  const lines = [BASE_PROMPT, toolList, stateInstruction, `Current task: ${task}`];

  if (modelParams.tier === 'SMALL') {
    lines.push(SMALL_MODEL_CONSTRAINTS);
  }

  return lines.filter(Boolean).join('\n\n').trim();
}

export function buildUserPrompt(state: State, task: string): string {
  switch (state) {
    case State.ANALYZE:
      return task;
    case State.LOCATE:
      return `Locate the code positions for: ${task}`;
    case State.MODIFY:
      return `Apply the changes for: ${task}`;
    case State.VERIFY:
      return `Verify the changes are correct for: ${task}`;
    default:
      return task;
  }
}
