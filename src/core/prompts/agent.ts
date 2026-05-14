import { State, type ModelParams, type StateContext } from '../types.js';

export interface SystemPromptOptions {
  state: State;
  task: string;
  modelParams: ModelParams;
  context?: StateContext;
  focus?: string;
}

const BASE_PROMPT = `You are an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.

You can answer questions, have conversations, and assist with any coding task. Use tools when needed — otherwise reply directly.`;

const STATE_INSTRUCTIONS: Partial<Record<State, string>> = {
  [State.REASON]: `Analyze the user request and create an execution plan.

Available states and their tools:
- ANALYZE:      read files, understand codebase          (tools: read)
- LOCATE:       find exact code positions                (tools: read, grep, find, ast_code_locator)
- MODIFY:       make code changes                        (tools: read, edit, write)
- VERIFY:       check correctness, run tests             (tools: read, bash)
- ANSWER:       respond with text only, no tools needed
- DIAGNOSE:     investigate bugs read-only               (tools: read, grep, bash)
- REVIEW:       code review read-only                    (tools: read, grep)
- RUN:          execute commands                         (tools: bash)
- RESEARCH:     web search and fetch                     (tools: webfetch, websearch)
- SETUP:        initialize project                       (tools: read, bash, write)

Rules:
- Choose the MINIMUM steps needed.
  - Simple questions → just [{"state":"ANSWER","focus":"..."}]
  - Simple edits where location is obvious → [MODIFY, VERIFY] (skip ANALYZE/LOCATE)
  - Complex edits → [ANALYZE, LOCATE, MODIFY, VERIFY]
- Each step must have a specific "focus" describing exactly what to do.
- Maximum 6 steps total.
- Multi-task requests: include all steps for all sub-tasks in sequence.

Output JSON:
{"steps": [{"state": "<STATE>", "focus": "<specific goal>"}], "needsClarify": false}

If clarification needed:
{"steps": [], "needsClarify": true, "questions": ["<q1>", "<q2>"]}`,

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
Output JSON: {"refactorSteps": ["<step1>", ...], "estimatedFiles": <n>}`,

  [State.ROLLBACK]: `Restore the modified files to their previous state using the write tool.
Output JSON: {"restored": ["<file1>", ...]}`,

  [State.RUN]: `Execute the command the user requested using the bash tool.

Steps:
1. Run the command exactly as requested
2. If the command fails, report the error clearly — do NOT attempt to fix code
3. If the command succeeds, summarize the output concisely

Output JSON when done:
{"exitCode": <exit code>, "summary": "<what happened, key output lines>"}

Rules:
- Run the command the user asked for, not a different one
- Do NOT modify any files — this state is execution-only
- Do NOT install packages the user did not ask for
- If the command requires interactive input, report that it cannot run non-interactively`,

  [State.RESEARCH]: `Research the user's question using web tools. Answer based on what you find.

Strategy:
- If user provides a URL → use webfetch to read it
- If user asks about a topic or error → use websearch first, then webfetch for details
- Combine multiple sources if needed for a complete answer

Output:
- Answer the user's question directly in plain text
- Cite source URLs for key claims
- If information is outdated or conflicting across sources, say so

Rules:
- Do NOT modify any files
- Do NOT execute any commands
- Summarize long pages — do not dump raw content`,

  [State.SETUP]: `Analyze this project and generate an AGENTS.md file that helps AI assistants understand the project conventions.

Steps:
1. Read package.json (or equivalent) to understand tech stack and scripts
2. Read existing config files: tsconfig.json, .eslintrc, .prettierrc, vitest.config.*
3. Run: ls src/ to understand structure
4. Check for existing AGENTS.md, CLAUDE.md, or README.md
5. Identify: build/test/lint commands, primary language and framework, code style conventions, key directories
6. Write AGENTS.md to the project root covering: tech stack, commands, conventions, key files

Output JSON when done:
{"created": "AGENTS.md", "summary": "<brief description of what was captured>"}

Rules:
- Keep AGENTS.md concise (target ~100-150 lines)
- If AGENTS.md already exists, update it rather than overwrite
- Do NOT modify any source files`,
};

const SMALL_MODEL_CONSTRAINTS = `Keep responses concise (under 400 tokens). Only use the listed tools. Do not speculate.`;

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const { state, task, modelParams, context, focus } = options;

  if (state === State.DONE) {
    return 'Task complete.';
  }

  const toolList = context?.availableTools?.length
    ? `Available tools:\n${context.availableTools.map((t) => `- ${t.name}`).join('\n')}`
    : '';

  const stateInstruction = STATE_INSTRUCTIONS[state] ?? '';
  const focusLine = focus ? `Current focus: ${focus}` : '';

  const lines = [BASE_PROMPT, toolList, stateInstruction, `Current task: ${task}`, focusLine];

  if (modelParams.tier === 'SMALL') {
    lines.push(SMALL_MODEL_CONSTRAINTS);
  }

  return lines.filter(Boolean).join('\n\n').trim();
}

export function buildUserPrompt(state: State, task: string, focus?: string): string {
  const target = focus ?? task;
  switch (state) {
    case State.ANALYZE:
      return target;
    case State.LOCATE:
      return `Locate the code positions for: ${target}`;
    case State.MODIFY:
      return `Apply the changes for: ${target}`;
    case State.VERIFY:
      return `Verify the changes are correct for: ${target}`;
    default:
      return target;
  }
}
