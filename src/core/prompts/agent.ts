import { State, type ModelParams, type StateContext } from '../types.js';

export interface EnvContext {
  cwd: string;
  platform: string;
  isGitRepo: boolean;
  date: string;
  projectTree?: string;
  suggestedFiles?: Array<{ path: string; hint?: string }>;
}

export interface SystemPromptOptions {
  state: State;
  task: string;
  modelParams: ModelParams;
  context?: StateContext;
  focus?: string;
  env?: EnvContext;
}

const STATES_NEEDING_TREE = new Set([State.LOCATE, State.RESEARCH, State.DIAGNOSE, State.REVIEW, State.REFACTOR_PLAN]);

function buildBasePrompt(env?: EnvContext, state?: State): string {
  let envBlock = '';
  if (env) {
    const treeSection =
      state && STATES_NEEDING_TREE.has(state) && env.projectTree
        ? `\n<project_structure>\n${env.projectTree}\n</project_structure>`
        : '';
    const suggestedSection =
      state && STATES_NEEDING_TREE.has(state) && env.suggestedFiles?.length
        ? `\n<suggested_files>\n${env.suggestedFiles.map((f) => `- ${f.path}${f.hint ? ` (${f.hint})` : ''}`).join('\n')}\n</suggested_files>`
        : '';
    envBlock = `<env>
  Working directory: ${env.cwd}
  Platform: ${env.platform}
  Is git repo: ${env.isGitRepo ? 'yes' : 'no'}
  Today's date: ${env.date}${treeSection}${suggestedSection}
</env>`;
  }

  return [
    `You are an expert coding assistant running in a terminal. You help users with software engineering tasks by reading files, executing commands, editing code, and writing new files.`,
    envBlock,
    `# Behavior
- Be concise and direct. Answer in as few words as possible.
- Do NOT add preamble ("Sure, I'll...") or postamble ("I hope this helps!").
- Output text to communicate with the user. Only use tools to complete tasks.
- Do NOT use emojis unless the user asks.
- Responses are displayed in a terminal with markdown rendering.

# Code changes
- ALWAYS read a file before editing it. Never guess line numbers.
- Make minimal, focused changes. Do not modify unrelated code.
- ALWAYS prefer editing existing files over creating new ones.
- Preserve the existing code style and conventions.
- Never suppress type errors with casts or ignore comments.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

const STATE_INSTRUCTIONS: Partial<Record<State, string>> = {
  [State.REASON]: `Analyze the user request and output a JSON execution plan. Do NOT call any tools. Output JSON ONLY.

Choose the MINIMUM steps needed:
- Pure Q&A (no files needed, e.g. "what is X?") → [ANSWER]
- Understand / explain / summarize / report code → [RESEARCH]
- Web search / URL / external topic → [RESEARCH]
- Code quality review / find issues → [REVIEW]
- Simple edit (location obvious) → [MODIFY, VERIFY]
- Edit requiring search → [LOCATE, MODIFY, VERIFY]
- Complex edit → [LOCATE, MODIFY, VERIFY]
- Bug investigation → [DIAGNOSE, LOCATE, MODIFY, VERIFY]
- Run a command → [RUN]
- Project init → [SETUP]

Each step needs a specific "focus" — exactly what to do in that step.
Maximum 6 steps.

Output JSON:
{"steps": [{"state": "<STATE>", "focus": "<specific goal>"}], "needsClarify": false}

If the request is ambiguous:
{"steps": [], "needsClarify": true, "questions": ["<q1>", "<q2>"]}`,

  [State.CLARIFY]: `The task is ambiguous. List what you need from the user.
Output JSON: {"questions": ["<q1>", "<q2>"]}
Maximum 3 questions. Be specific.`,

  [State.LOCATE]: `Locate the exact code positions that need to change.

Steps:
1. Read the relevant files to understand the current code
2. Use grep/find if you need to search across files
3. Identify the precise lines and snippets

Output JSON:
{"locations": [{"file": "<path>", "startLine": <n>, "endLine": <n>, "snippet": "<current code>"}]}`,

  [State.MODIFY]: `Apply the code changes.

Rules:
- Read each file before editing it
- Make one focused change at a time
- Do not modify unrelated code
- Prefer edit over write for existing files

After all changes, output JSON:
{"edited": ["<file1>", "<file2>"], "linesChanged": <total>}`,

  [State.VERIFY]: `Verify the changes are correct.

Steps:
1. Read the modified files to confirm changes look right
2. Run type checks or tests if available (bash: npx tsc --noEmit, npm test, etc.)
3. Report results

Output JSON:
{"passed": true|false, "issues": ["<issue>", ...], "summary": "<result>"}`,

  [State.ANSWER]: `Answer the question directly. No tools needed. Reply in plain text.`,

  [State.DIAGNOSE]: `Investigate the root cause. Read files and search code — do NOT modify anything.

Output JSON:
{"rootCause": "<explanation>", "location": "<file:line>", "fix": "<suggested fix>"}`,

  [State.REVIEW]: `Review the code for quality, correctness, and issues. Read files only — do NOT modify anything.

Output JSON:
{"issues": ["<issue>", ...], "suggestions": ["<suggestion>", ...], "verdict": "pass|fail"}`,

  [State.TEST_WRITE]: `Write tests for the specified code. Do NOT modify business logic files.

Output JSON:
{"testFile": "<path>", "cases": <number of test cases>}`,

  [State.REFACTOR_PLAN]: `Plan the refactoring without making any changes. Read files to understand scope.

Output JSON:
{"refactorSteps": ["<step1>", ...], "estimatedFiles": <n>}`,

  [State.ROLLBACK]: `Restore the modified files to their previous state using the write tool.

Output JSON:
{"restored": ["<file1>", ...]}`,

  [State.RUN]: `Execute the requested command using bash.

Rules:
- Run exactly the command requested — not a variation
- Do NOT modify any files
- Do NOT install packages the user did not ask for
- If the command needs interactive input, report it cannot run non-interactively

Output JSON when done:
{"exitCode": <n>, "summary": "<what happened, key output>"}`,

  [State.RESEARCH]: `Research and investigate the topic. Read local files or search the web as needed.

Strategy:
- Understand/explain/report local code → read files, ls, grep to explore the codebase
- URL provided → webfetch it directly
- Web topic or error → websearch first, then webfetch top results for detail
- Mixed (local + web) → read local files first, then supplement with web search

Output: plain text report with findings. Cite file paths or source URLs.
Do NOT modify files or run commands.`,

  [State.SETUP]: `Analyze this project and generate AGENTS.md.

Steps:
1. Read package.json (or equivalent) for tech stack and scripts
2. Read config files: tsconfig.json, .eslintrc, .prettierrc, vitest.config.*
3. Run ls src/ to understand structure
4. Check for existing AGENTS.md, CLAUDE.md, README.md
5. Write AGENTS.md covering: tech stack, build/test/lint commands, conventions, key files

Output JSON when done:
{"created": "AGENTS.md", "summary": "<what was captured>"}

Rules:
- Target ~100-150 lines. Be concise.
- If AGENTS.md already exists, update it.
- Do NOT modify source files.`,
};

const SMALL_MODEL_CONSTRAINTS = `Keep responses under 400 tokens. Use only the listed tools. Do not speculate.`;

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const { state, task, modelParams, context, focus, env } = options;

  if (state === State.DONE) {
    return 'Task complete.';
  }

  const base = buildBasePrompt(env, state);

  const toolList = context?.availableTools?.length
    ? `Available tools:\n${context.availableTools.map((t) => `- ${t.name}`).join('\n')}`
    : '';

  const stateInstruction = STATE_INSTRUCTIONS[state] ?? '';
  const focusLine = focus ? `Current focus: ${focus}` : '';

  const lines = [base, toolList, stateInstruction, `Current task: ${task}`, focusLine];

  if (modelParams.tier === 'SMALL') {
    lines.push(SMALL_MODEL_CONSTRAINTS);
  }

  return lines.filter(Boolean).join('\n\n').trim();
}

export function buildUserPrompt(state: State, task: string, focus?: string): string {
  const target = focus ?? task;
  switch (state) {
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
