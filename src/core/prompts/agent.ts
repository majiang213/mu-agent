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
  [State.ANALYZE]: `When given a coding task, identify what needs to change and output a brief plan as JSON:
{"summary": "<one sentence>", "files": ["<path>", ...], "approach": "<how to implement>"}
For questions or conversation, reply naturally in plain text.`,

  [State.LOCATE]: `Locate the exact file paths and line numbers that need to be modified. Output JSON:
{"locations": [{"file": "<path>", "startLine": <n>, "endLine": <n>, "snippet": "<code>"}]}`,

  [State.MODIFY]: `Apply minimal, focused code changes using the edit or write tools. After each change output:
{"edited": "<file>", "linesChanged": <n>}`,

  [State.VERIFY]: `Verify the changes are correct. Run type checks or tests if available. Output JSON:
{"passed": true|false, "issues": ["<issue>", ...], "summary": "<result>"}`,
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

  const lines = [
    BASE_PROMPT,
    toolList,
    stateInstruction,
    `Current task: ${task}`,
  ];

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
