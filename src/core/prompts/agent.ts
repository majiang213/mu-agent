import { State, type ModelParams, type StateContext } from '../types.js';

export interface EnvContext {
  cwd: string;
  platform: string;
  isGitRepo: boolean;
  date: string;
  projectTree?: string;
  suggestedFiles?: Array<{ path: string; hint?: string }>;
  snippets?: Record<string, string>;
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
    const snippetEntries = env.snippets ? Object.entries(env.snippets) : [];
    const snippetsSection =
      state && STATES_NEEDING_TREE.has(state) && snippetEntries.length
        ? `\n<code_snippets>\n${snippetEntries.map(([file, code]) => `// ${file}\n${code}`).join('\n\n')}\n</code_snippets>`
        : '';
    envBlock = `<env>
  Working directory: ${env.cwd}
  Platform: ${env.platform}
  Is git repo: ${env.isGitRepo ? 'yes' : 'no'}
  Today's date: ${env.date}${treeSection}${suggestedSection}${snippetsSection}
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
  [State.REASON]: `Analyze the task and choose the MINIMUM steps needed:

- Greeting / chitchat / pure Q&A (no files needed) → [ANSWER]
- Understand / explain / summarize / report code → [RESEARCH]
- Web search / URL / external info → [RESEARCH]
- Code quality review / find issues → [REVIEW]
- Simple edit (file and location obvious) → [MODIFY, VERIFY]
- Edit requiring search first → [LOCATE, MODIFY, VERIFY]
- Bug investigation → [DIAGNOSE, LOCATE, MODIFY, VERIFY]
- Run a command → [RUN]
- Project setup / generate AGENTS.md → [SETUP]

Each step needs a specific "focus" describing exactly what to do. Maximum 6 steps.

When done, call complete(steps=[...], needsClarify=false).
If intent is genuinely unclear, call complete(steps=[], needsClarify=true, questions=["<question>"]).

Examples:
- Chitchat/Q&A: complete(steps=[{state:"ANSWER", focus:"respond to greeting"}], needsClarify=false)
- Code edit:    complete(steps=[{state:"LOCATE",focus:"find login function"},{state:"MODIFY",focus:"add null check"}], needsClarify=false)
- Need info:    complete(steps=[], needsClarify=true, questions=["Which file should I edit?"])`,

  [State.CLARIFY]: `The task is ambiguous. List what you need from the user. Maximum 3 questions.

When done, call complete(questions=["<q1>", "<q2>"]).`,

  [State.LOCATE]: `Locate the exact code positions that need to change.

Steps:
1. Read the relevant files to understand the current code
2. Use grep/find if you need to search across files
3. Identify the precise lines and snippets

When done, call complete(locations=[{file, startLine, endLine, snippet}]).`,

  [State.MODIFY]: `Apply the code changes identified in the LOCATE step.

The \`edit\` tool does SEARCH/REPLACE: it finds \`oldText\` in the file and replaces it with \`newText\`.

Rules:
1. Read the file first to get the exact current content
2. \`oldText\` must match the file EXACTLY (character for character, including whitespace)
3. \`oldText\` should be SHORT — just the lines being changed plus 1-2 lines of context for uniqueness. Do NOT copy the whole function or file.
4. One focused change per \`edit\` call. Use multiple \`edit\` calls for multiple changes.
5. Use \`write\` only for new files, never for existing ones.

Example — adding a null check:
  oldText:  "function login(user, pass) {\\n  return db.check(user);"
  newText:  "function login(user, pass) {\\n  if (!user) throw new Error('no user');\\n  return db.check(user);"

When done, call complete(edited=["<file>", ...], linesChanged=<n>).`,

  [State.VERIFY]: `Verify the changes work correctly.

- If there are test files related to the changes, run them with bash
- If the project has a build command (e.g. tsc, cargo build, go build), run it to check compilation across all files
- Read the modified files to confirm the logic is correct

Do NOT re-check syntax or type errors — those were already caught during editing.

When done, call complete(passed=true|false, issues=[...], summary="<result>").`,

  [State.ANSWER]: `Answer the question directly. When done, call complete(answer="<your answer>").`,

  [State.DIAGNOSE]: `Investigate the root cause. Read files and search code — do NOT modify anything.

When done, call complete(rootCause="<explanation>", location="<file:line>", fix="<suggested fix>").`,

  [State.REVIEW]: `Review the code for quality, correctness, and issues.

Available tools: read, grep, complete. You do NOT have bash.
To read a file use the read tool, NOT cat or shell commands.
Do NOT modify anything.

When done, call complete(issues=[...], suggestions=[...], verdict="pass"|"fail").`,

  [State.TEST_WRITE]: `Write tests for the specified code. Do NOT modify business logic files.

When done, call complete(testFile="<path>", cases=<number>).`,

  [State.REFACTOR_PLAN]: `Plan the refactoring without making any changes.

Available tools: read, complete. You do NOT have bash.
To read a file use the read tool, NOT cat or shell commands.

When done, call complete(refactorSteps=["<step1>", ...], estimatedFiles=<n>).`,

  [State.ROLLBACK]: `Restore the modified files to their previous state using the write tool.

When done, call complete(restored=["<file1>", ...]).`,

  [State.RUN]: `Execute the requested command using bash.

Rules:
- Run exactly the command requested — not a variation
- Do NOT modify any files
- Do NOT install packages the user did not ask for
- If the command needs interactive input, report it cannot run non-interactively

When done, call complete(exitCode=<n>, summary="<what happened, key output>").`,

  [State.RESEARCH]: `Research and investigate the topic.

Available tools: read, ls, grep, find, webfetch, websearch, complete.
You do NOT have bash. To read a file use the read tool, NOT cat or shell commands.
To list a directory use ls with path parameter: ls(path="src") NOT ls("src") or ls src.

Strategy:
- Understand/explain/report local code → use read/ls/grep/find to explore
- URL provided → webfetch it directly
- Web topic or error → websearch first, then webfetch top results
- Mixed (local + web) → read local files first, then supplement with web search

Do NOT modify files.
When done, call complete(report="<your findings, cite file paths or URLs>").`,

  [State.SETUP]: `Analyze this project and generate AGENTS.md.

Steps:
1. Read package.json (or equivalent) for tech stack and scripts
2. Read config files: tsconfig.json, .eslintrc, .prettierrc, vitest.config.*
3. List src/ directory: ls(path="src")
4. Check for existing AGENTS.md, CLAUDE.md, README.md
5. Write AGENTS.md covering: tech stack, build/test/lint commands, conventions, key files

Rules:
- Target ~100-150 lines. Be concise.
- If AGENTS.md already exists, update it.
- Do NOT modify source files.

When done, call complete(created="AGENTS.md", summary="<what was captured>").`,
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
