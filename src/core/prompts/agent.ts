import { State, STATES_NEEDING_CODE_CONTEXT, type ModelParams, type StateContext } from '../types.js';
import type { AgentContext } from '../agent/context.js';
import type { ExecutedStep } from '../types.js';
import { STATE_REGISTRY } from '../state-registry.js';

export interface EnvContext {
  cwd: string;
  platform: string;
  isGitRepo: boolean;
  date: string;
  projectTree?: string;
  suggestedFiles?: Array<{ path: string; hint?: string }>;
  snippets?: Record<string, string>;
  projectContext?: AgentContext;
}

export interface SystemPromptOptions {
  state: State;
  task: string;
  modelParams: ModelParams;
  context?: StateContext;
  focus?: string;
  env?: EnvContext;
  memoryIndex?: string;
}

function buildBasePrompt(env?: EnvContext, state?: State): string {
  let envBlock = '';
  if (env) {
    const treeSection =
      state && STATES_NEEDING_CODE_CONTEXT.has(state) && env.projectTree
        ? `\n<project_structure>\n${env.projectTree}\n</project_structure>`
        : '';
    const suggestedSection =
      state && STATES_NEEDING_CODE_CONTEXT.has(state) && env.suggestedFiles?.length
        ? `\n<suggested_files>\n${env.suggestedFiles.map((f) => `- ${f.path}${f.hint ? ` (${f.hint})` : ''}`).join('\n')}\n</suggested_files>`
        : '';
    const snippetEntries = env.snippets ? Object.entries(env.snippets) : [];
    const snippetsSection =
      state && STATES_NEEDING_CODE_CONTEXT.has(state) && snippetEntries.length
        ? `\n<code_snippets>\n${snippetEntries.map(([file, code]) => `// ${file}\n${code}`).join('\n\n')}\n</code_snippets>`
        : '';
    envBlock = `<env>
  Working directory: ${env.cwd}
  Platform: ${env.platform}
  Is git repo: ${env.isGitRepo ? 'yes' : 'no'}
  Today's date: ${env.date}${treeSection}${suggestedSection}${snippetsSection}
</env>`;
  }

  const projectContextBlock = env?.projectContext
    ? `<project_context source="${env.projectContext.source}">\n${env.projectContext.content}\n</project_context>`
    : '';

  return [
    `You are an expert coding assistant running in a terminal. You help users with software engineering tasks by reading files, executing commands, editing code, and writing new files.`,
    envBlock,
    projectContextBlock,
    `# Behavior
- Be concise and direct. Answer in as few words as possible.
- Do NOT add preamble ("Sure, I'll...") or postamble ("I hope this helps!").
- Output text to communicate with the user. Only use tools to complete tasks.
- IMPORTANT: Any text you write in your response is shown to the user as commentary only — it does NOT trigger tool execution. To call a tool, you MUST invoke it as a tool call, not write it in text. This applies especially to complete() — writing "complete(...)" in your response text does nothing; you must call it as a tool.
- Do NOT use emojis unless the user asks.
- Responses are displayed in a terminal with markdown rendering.
- After completing a task, stop. Do NOT add explanations of what you did unless asked.
- When referencing a specific function or line of code, use the format \`file_path:line_number\` so the user can navigate directly.
- When running a non-trivial bash command, briefly explain what it does and why before running it.

# Code changes
- ALWAYS read a file before editing it. Never guess line numbers.
- Make minimal, focused changes. Do not modify unrelated code.
- ALWAYS prefer editing existing files over creating new ones.
- Preserve the existing code style and conventions.
- Never suppress type errors with casts or ignore comments.
- NEVER add comments to code unless explicitly asked. Write self-documenting code instead.
- NEVER assume a library is available. Check the codebase (package.json, imports) before using any dependency.
- NEVER commit changes unless the user explicitly asks you to commit.
- NEVER write secrets, API keys, or credentials into code or files.
- For file exploration, prefer grep/find/ls tools over bash — they are faster and respect .gitignore.
- After completing a code change, run the project's lint and typecheck commands if known (e.g. npm run lint, tsc --noEmit, ruff).`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

const SMALL_MODEL_CONSTRAINTS = `Keep responses under 400 tokens. Do not speculate.`;
const SMALL_MODEL_CONSTRAINTS_WITH_TOOLS = `Keep responses under 400 tokens. Use only the listed tools. Do not speculate.`;

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const { state, task, modelParams, context, focus, env, memoryIndex } = options;

  if (state === State.DONE) {
    return 'Task complete.';
  }

  const base = buildBasePrompt(env, state);
  const memoryBlock = memoryIndex ?? '';

  const toolList = context?.availableTools?.length
    ? `Available tools:\n${context.availableTools.map((t) => `- ${t.name}`).join('\n')}`
    : '';

  const stateInstruction = STATE_REGISTRY[state]?.instruction ?? '';
  const focusLine = focus ? `Current focus: ${focus}` : '';

  const lines = [base, memoryBlock, toolList, stateInstruction, `Current task: ${task}`, focusLine];

  if (modelParams.tier === 'SMALL') {
    const constraints = state === State.REASON ? SMALL_MODEL_CONSTRAINTS : SMALL_MODEL_CONSTRAINTS_WITH_TOOLS;
    lines.push(constraints);
  }

  return lines.filter(Boolean).join('\n\n').trim();
}

function projectOutput(receiverState: State, sourceState: State, rawOutput: string): string {
  const allowedFields = STATE_REGISTRY[receiverState]?.contextFilter?.[sourceState];
  if (!allowedFields) return rawOutput;
  try {
    const parsed = JSON.parse(rawOutput) as Record<string, unknown>;
    const filtered = Object.fromEntries(Object.entries(parsed).filter(([k]) => allowedFields.includes(k)));
    return JSON.stringify(filtered);
  } catch {
    return rawOutput;
  }
}

function fmtPreStepCtx(state: State, previousResults: ExecutedStep[]): string {
  if (previousResults.length === 0) return '';
  const trunc = (s: string) => (s.length > 600 ? s.slice(0, 600) + '…' : s);

  // VERIFY: special handling for Gap 41 (path audit) + Gap 43 (multi-MODIFY merge)
  if (state === State.VERIFY) {
    const allEdited: string[] = [];
    let lastModify: ExecutedStep | undefined;
    for (const r of previousResults) {
      if (r.state === State.MODIFY) {
        lastModify = r;
        try {
          const parsed = JSON.parse(r.output) as { edited?: unknown };
          if (Array.isArray(parsed.edited)) {
            for (const f of parsed.edited) {
              if (typeof f === 'string') allEdited.push(f);
            }
          }
        } catch {
          // non-JSON output: skip
        }
      }
    }
    const locateDiag = previousResults.filter((r) => r.state === State.LOCATE || r.state === State.DIAGNOSE);
    const lines: string[] = [];
    if (lastModify) {
      const out = projectOutput(State.VERIFY, State.MODIFY, lastModify.output);
      lines.push(`[MODIFY] ${lastModify.focus}\n${trunc(out)}`);
    }
    const uniqueEdited = [...new Set(allEdited)];
    if (uniqueEdited.length > 1) {
      lines.push(`[MODIFY] all edited files: ${uniqueEdited.join(', ')}`);
    }
    for (const r of locateDiag) {
      const out = projectOutput(State.VERIFY, r.state as State, r.output);
      lines.push(`[${r.state}] ${r.focus}\n${trunc(out)}`);
    }
    if (lines.length === 0) return '';
    return `\n\n<previous_step_results>\n${lines.join('\n\n')}\n</previous_step_results>`;
  }

  const needs = STATE_REGISTRY[state]?.contextNeeds;
  if (!needs || needs.length === 0) return '';

  const relevant = previousResults.filter((r) => needs.includes(r.state as State));
  if (relevant.length === 0) return '';

  const allLines = relevant.map((r) => {
    const out = projectOutput(state, r.state as State, r.output);
    return `[${r.state}] ${r.focus}\n${trunc(out)}`;
  });

  const BUDGET = 8000;
  const kept: string[] = [];
  let total = 0;
  for (let i = allLines.length - 1; i >= 0; i--) {
    const line = allLines[i] ?? '';
    const len = line.length;
    if (total + len > BUDGET) break;
    kept.unshift(line);
    total += len;
  }

  if (kept.length === 0) return '';
  return `\n\n<previous_step_results>\n${kept.join('\n\n')}\n</previous_step_results>`;
}

export function buildUserPrompt(state: State, task: string, focus?: string, previousResults?: ExecutedStep[]): string {
  const target = focus ?? task;
  const context = previousResults ? fmtPreStepCtx(state, previousResults) : '';
  switch (state) {
    case State.LOCATE:
      return `Locate the code positions for: ${target}${context}`;
    case State.MODIFY:
      return `Apply the changes for: ${target}${context}`;
    case State.WRITE:
      return `Create new files for: ${target}${context}`;
    case State.VERIFY:
      return `Verify the changes are correct for: ${target}${context}`;
    default:
      return `${target}${context}`;
  }
}
