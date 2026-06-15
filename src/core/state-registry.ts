import { Type } from '@sinclair/typebox';
import { State } from './types.js';

export interface StateDefinition {
  allowedTools: string[];
  instruction: string;
  reminderFields?: string;
  completeSchema: ReturnType<typeof Type.Object>;
  contextNeeds?: State[];
}

export const STATE_REGISTRY: Record<State, StateDefinition> = {
  [State.REASON]: {
    allowedTools: ['complete'],
    instruction: `You have ONE tool: complete(). Do NOT call any other tool. Do NOT read files. Do NOT run commands.
Your ONLY job is to analyze the task description and call complete() with a plan.

Choose the MINIMUM steps needed based on the task description alone:

- Greeting / chitchat / pure Q&A → [] (empty steps — ANSWER runs automatically after)
- Understand / explain / summarize / check code → [RESEARCH]
- Web search or external info needed → [RESEARCH]
- Code quality review → [REVIEW]
- Check / inspect / look for issues (no explicit fix requested) → [RESEARCH]
- Fix bug when file+location are NOT stated explicitly → [LOCATE, MODIFY, VERIFY]
- Fix bug when file+location ARE stated explicitly → [MODIFY, VERIFY]
- Bug investigation (cause unknown) → [DIAGNOSE, LOCATE, MODIFY, VERIFY]
- Tests failing, fix them → [DIAGNOSE, LOCATE, MODIFY, VERIFY]
- Tests failing, complex codebase (need to understand context) → [DIAGNOSE, RESEARCH, LOCATE, MODIFY, VERIFY]
- Code review + fix (no tests, static analysis only) → [RESEARCH, LOCATE, MODIFY, VERIFY]
- Generate or update AGENTS.md documentation file → [SETUP]
  (NEVER use SETUP for running tests, diagnosing bugs, or fixing code — use DIAGNOSE for that)

RULES:
- NEVER go straight to MODIFY without LOCATE unless the exact file and change are given in the task.
- "Check", "inspect", "look for problems", "review" → start with RESEARCH or REVIEW, not MODIFY.
- MODIFY focus must describe the code change, NOT a diagnostic task.

Each step needs a "focus" describing exactly what to do. Maximum 6 steps.

For each step, optionally add "why" (max 15 words): your key assumption or reasoning.
Only fill "why" when it adds real information — skip for obvious steps.

Call complete(steps=[...], needsClarify=false).
If intent is genuinely unclear, call complete(steps=[], needsClarify=true, questions=["<question>"]).

Examples:
- Chitchat/Q&A: complete(steps=[], needsClarify=false)
- Explain code: complete(steps=[{state:"RESEARCH", focus:"read and explain how auth.ts works"}], needsClarify=false)
- Check for issues: complete(steps=[{state:"RESEARCH", focus:"read calc.js and identify any bugs or problems"}], needsClarify=false)
- Web search:   complete(steps=[{state:"RESEARCH", focus:"search for best practices for JWT expiry"}], needsClarify=false)
- Review code:  complete(steps=[{state:"REVIEW", focus:"review auth.js for security issues"}], needsClarify=false)
- Fix failing tests: complete(steps=[{state:"DIAGNOSE",focus:"run npm test to capture failing output"},{state:"LOCATE",focus:"find exact lines in calc.js to change"},{state:"MODIFY",focus:"add divide-by-zero guard"},{state:"VERIFY",focus:"run npm test"}], needsClarify=false)
- Fix bug (location known): complete(steps=[{state:"LOCATE",focus:"find divide function in calc.js"},{state:"MODIFY",focus:"add zero-check before division"},{state:"VERIFY",focus:"run npm test"}], needsClarify=false)
- Simple edit (file+line explicit): complete(steps=[{state:"MODIFY", focus:"rename variable foo to bar in utils.ts line 42"},{state:"VERIFY",focus:"run tsc to check no errors"}], needsClarify=false)
- Investigate:  complete(steps=[{state:"DIAGNOSE",focus:"why does login fail for admin users"},{state:"LOCATE",focus:"find the bug location"},{state:"MODIFY",focus:"fix root cause"},{state:"VERIFY",focus:"run tests"}], needsClarify=false)
- Setup:        complete(steps=[{state:"SETUP", focus:"analyze project and generate AGENTS.md"}], needsClarify=false)
- Need info:    complete(steps=[], needsClarify=true, questions=["Which file should I edit?"])
- Retry after VERIFY failure: complete(steps=[{state:"ROLLBACK",focus:"restore files to checkpoint"},{state:"DIAGNOSE",focus:"why did the fix not work"},{state:"MODIFY",focus:"apply correct fix based on diagnosis"},{state:"VERIFY",focus:"run tests again"}], needsClarify=false)
- Accept failure (cannot fix): complete(steps=[], needsClarify=false)
- Multiple independent files to modify: complete(steps=[{state:"LOCATE",focus:"find all files to change"},{parallel:[{state:"MODIFY",focus:"fix divide() in calc.js"},{state:"MODIFY",focus:"fix DELETE route in server.js"}]},{state:"VERIFY",focus:"run npm test"}], needsClarify=false)`,
    completeSchema: Type.Object({
      steps: Type.Array(
        Type.Union([
          Type.Object({
            state: Type.String({ description: 'State name, e.g. LOCATE, MODIFY, VERIFY, ANSWER, RESEARCH' }),
            focus: Type.String({ description: 'What to do in this step' }),
            why: Type.Optional(
              Type.String({
                description: 'In max 15 words: why this step and why this approach. Skip for obvious steps.',
              }),
            ),
          }),
          Type.Object({
            parallel: Type.Array(
              Type.Object({
                state: Type.String({ description: 'State name for this parallel step' }),
                focus: Type.String({ description: 'What to do in this parallel step' }),
                why: Type.Optional(Type.String({ description: 'In max 15 words: why this step.' })),
              }),
              { description: 'Array of independent steps to execute concurrently', minItems: 2 },
            ),
          }),
        ]),
      ),
      needsClarify: Type.Boolean(),
      questions: Type.Optional(Type.Array(Type.String())),
    }),
  },

  [State.CLARIFY]: {
    allowedTools: ['complete'],
    instruction: `The task is ambiguous. Ask the user for the information needed to proceed.

You have ONE tool: complete(). Do NOT read files or run commands.
Maximum 3 questions — ask only what is genuinely unclear.

<example>
task: fix the bug
assistant: complete(questions=["Which file contains the bug?", "What is the expected behavior?"])
</example>

When done, call complete(questions=["<q1>", "<q2>"]).`,
    completeSchema: Type.Object({
      questions: Type.Array(Type.String({ description: 'Question to ask the user' })),
    }),
  },

  [State.LOCATE]: {
    allowedTools: ['read', 'ast_code_locator', 'complete'],
    instruction: `Locate the exact code positions that need to change.

Available tools: read, ast_code_locator, complete.
The project structure and candidate files have already been identified for you (see <suggested_files> and <code_snippets> above).
Read the suggested files to confirm the exact lines and understand the current code.

Steps:
1. Read the suggested files to understand the current code
2. Use ast_code_locator if you need to find a specific function or symbol by name
3. Identify the precise lines and snippets

CRITICAL: snippet must contain ONLY code that currently exists in the file at those line numbers.
NEVER include code you plan to add — snippet is what IS in the file right now, not what should be there after the fix.

<example>
focus: find the divide function in calc.js
assistant: [reads calc.js] — finds divide() at line 15
complete(locations=[{file:"calc.js", startLine:15, endLine:19, snippet:"function divide(a, b) { return a / b; }"}])
</example>

As soon as you have identified all relevant code positions, call complete(locations=[...]) IMMEDIATELY.
Do NOT explain your findings before calling complete(). The complete() call IS your output.`,
    reminderFields: 'locations (array of {file, startLine, endLine, snippet})',
    completeSchema: Type.Object({
      locations: Type.Array(
        Type.Object({
          file: Type.String(),
          startLine: Type.Number(),
          endLine: Type.Number(),
          snippet: Type.String({ description: 'Current code at this location' }),
        }),
      ),
    }),
    contextNeeds: [State.RESEARCH, State.DIAGNOSE],
  },

  [State.MODIFY]: {
    allowedTools: ['read', 'edit', 'write', 'complete'],
    instruction: `Apply the code changes identified in the LOCATE step.

The \`edit\` tool does SEARCH/REPLACE: it finds \`oldText\` in the file and replaces it with \`newText\`.
Tool signature: edit(path="<path>", oldText="<exact text>", newText="<replacement>")
IMPORTANT: The parameter is named \`path\`. Always use: edit(path="calc.js", ...) NOT edit(file="calc.js", ...)

Rules:
1. Read the target file with the read tool BEFORE writing any edit call. Use the actual file content you just read to determine oldText — do NOT copy snippet from LOCATE as oldText, the snippet may contain imagined code that does not exist in the file yet.
2. Mimic the existing code style — naming, indentation, patterns already used in the file.
3. \`oldText\` must match the file EXACTLY (character for character, including whitespace).
4. \`oldText\` should be SHORT — just the lines being changed plus 1-2 lines of context for uniqueness. Do NOT copy the whole function or file.
5. One focused change per \`edit\` call. Use multiple \`edit\` calls for multiple changes.
6. Use \`write\` only for new files, never for existing ones.
7. NEVER assume a library is available. Check existing imports before using any dependency.
8. Call complete() ONLY after you have successfully called edit or write. If you have not yet modified any files, call edit or write FIRST — calling complete() without any prior edit/write call is wrong.

<example>
focus: add divide-by-zero guard to divide function in calc.js
assistant: [reads calc.js to see current code and style]
edit(path="calc.js", oldText="function divide(a, b) {\\n  return a / b;", newText="function divide(a, b) {\\n  if (b === 0) throw new Error('Division by zero');\\n  return a / b;")
complete(edited=["calc.js"], linesChanged=1)
</example>

When done, call complete(edited=["<file>", ...], linesChanged=<n>).`,
    reminderFields: 'edited (array of file paths), linesChanged (number)',
    completeSchema: Type.Object({
      edited: Type.Array(Type.String({ description: 'File path that was modified' })),
      linesChanged: Type.Number(),
    }),
    contextNeeds: [State.RESEARCH, State.DIAGNOSE, State.LOCATE],
  },

  [State.VERIFY]: {
    allowedTools: ['read', 'bash', 'complete'],
    instruction: `You are a test result reporter. Two steps, no more:
1. Run the test command with bash.
2. Call complete() with exactly what the output showed.

That is the entire job. There is no step 3.

HOW TO DECIDE:
- Output shows all passing → complete(passed=true, issues=[], summary="<test output>")
- Output shows any failure → complete(passed=false, issues=["<failure details>"], summary="<test output>")

WHY passed=false IS THE RIGHT CALL WHEN TESTS FAIL:
This system has a built-in retry loop. When you call passed=false, the system
automatically re-plans, fixes the code, and calls you again. That loop is how
bugs get fixed — you are the trigger. Calling passed=false is completing your
job correctly.

HOW TO USE bash:
bash is for running the test command only. Examples: npm test, npx tsc --noEmit,
python3 -m pytest, mvn -q test. Run it once, read the output, call complete().

If <previous_step_results> is present, path audit first:
1. Do MODIFY edited[] files overlap with LOCATE locations[]? If clearly not → complete(passed=false, issues=["wrong file edited"])
2. If they match or no LOCATE result → run tests as normal.

<example>
focus: verify calc.js fix
→ bash("npm test") → PASS ./calc.test.js, 7 passing
complete(passed=true, issues=[], summary="npm test: 7 passing")
</example>

<example>
focus: verify TypeScript fixes in api.ts
→ bash("npx tsc --noEmit") → api.ts(8,5): error TS2322, exit code 2
complete(passed=false, issues=["api.ts(8,5): TS2322 role type mismatch"], summary="tsc: 3 errors, exit 2")
</example>

When done, call complete(passed=true|false, issues=[...], summary="<test output>").`,
    reminderFields:
      'passed (boolean: true only if test output showed all passing, false if any failure), issues (array), summary (the actual test output)',
    completeSchema: Type.Object({
      passed: Type.Boolean(),
      issues: Type.Array(Type.String()),
      summary: Type.String(),
    }),
    contextNeeds: [State.MODIFY, State.LOCATE, State.DIAGNOSE],
  },

  [State.DONE]: {
    allowedTools: [],
    instruction: '',
    completeSchema: Type.Object({}, { additionalProperties: true }),
  },

  [State.ANSWER]: {
    allowedTools: ['complete'],
    instruction: `Present the result to the user.

You have ONE tool: complete(). Call it directly as a tool. Do NOT call any other tools.

If there are <previous_step_results>:
- Steps found and fixed bugs → summarize what was wrong and what was fixed.
- Steps only researched → summarize the findings.
- Steps ran tests → report pass/fail and what was verified.

If there are no <previous_step_results>:
- Answer the user's question directly from the task description and context.

<example>
previous: [RESEARCH] found 2 bugs in calc.js; [MODIFY] fixed divide and average; [VERIFY] npm test: 7 passing
assistant: complete(answer="Fixed 2 bugs in calc.js: (1) divide() now throws on b===0; (2) average() now throws on empty array. All 7 tests pass.")
</example>

<example>
previous: [RESEARCH] calc.js has no issues
assistant: complete(answer="calc.js looks good — no bugs found.")
</example>

When done, call complete(answer="<your summary>").`,
    reminderFields: 'answer (string)',
    completeSchema: Type.Object({
      answer: Type.String({ description: 'Your answer to the user' }),
    }),
    contextNeeds: [State.RESEARCH, State.DIAGNOSE, State.REVIEW, State.VERIFY, State.MODIFY],
  },

  [State.DIAGNOSE]: {
    allowedTools: ['read', 'grep', 'bash', 'complete'],
    instruction: `Investigate the root cause of the bug or issue.

IMPORTANT: Your ONLY job is to investigate and report findings.
- DO NOT modify any files. DO NOT run write commands (cat >, sed -i, etc.).
- As soon as you identify the root cause, call complete(rootCause=..., location=..., fix=...) IMMEDIATELY.
  The system will automatically plan a MODIFY step. Fixing is the job of MODIFY, not DIAGNOSE.

Available tools: read, grep, bash, complete.
You may call multiple tools in parallel when they are independent.
Do NOT modify any files.

Steps:
1. Read the relevant source files and test files
2. Use grep to search for related patterns
3. Use bash to run the failing command and capture the error output
4. Identify the exact root cause and location

<example>
focus: why does divide(10, 0) not throw?
assistant: [reads calc.js] → divide has no zero-check guard
complete(rootCause="divide() has no guard for b===0, returns Infinity silently", location="calc.js:15", fix="add: if (b === 0) throw new Error('Division by zero')")
</example>

When done, call complete(rootCause="<explanation>", location="<file:line>", fix="<suggested fix>").`,
    reminderFields: 'rootCause (string), location (string), fix (string)',
    completeSchema: Type.Object({
      rootCause: Type.String(),
      location: Type.String({ description: 'file:line where the bug is' }),
      fix: Type.String({ description: 'Suggested fix' }),
    }),
  },

  [State.REVIEW]: {
    allowedTools: ['read', 'grep', 'complete'],
    instruction: `Review the code for quality, correctness, and issues.

Available tools: read, grep, complete. You do NOT have bash.
To read a file use the read tool, NOT cat or shell commands.
You may read multiple files in parallel.
Do NOT modify anything.

<example>
focus: review auth.js for security issues
assistant: [reads auth.js and package.json in parallel]
→ finds hardcoded secret and missing token expiry
complete(issues=["hardcoded JWT secret at line 3","token has no expiry"], suggestions=["use process.env.JWT_SECRET","add expiresIn to jwt.sign()"], verdict="fail")
</example>

When done, call complete(issues=[...], suggestions=[...], verdict="pass"|"fail").`,
    reminderFields: 'issues (array), suggestions (array), verdict ("pass"|"fail")',
    completeSchema: Type.Object({
      issues: Type.Array(Type.String()),
      suggestions: Type.Array(Type.String()),
      verdict: Type.Union([Type.Literal('pass'), Type.Literal('fail')]),
    }),
    contextNeeds: [State.RESEARCH, State.DIAGNOSE],
  },

  [State.TEST_WRITE]: {
    allowedTools: ['read', 'write', 'edit', 'complete'],
    instruction: `Write tests for the specified code.

Available tools: read, write, edit, complete.
Do NOT modify business logic files — only create or edit test files.

Steps:
1. Read the source file to understand what needs to be tested
2. Look at existing test files to follow the same test framework and style
3. Write tests covering normal cases, edge cases, and error cases

<example>
focus: write tests for divide() in calc.js
assistant: [reads calc.js to understand divide(), reads calc.test.js to see test style]
→ writes tests for normal division, divide by zero, and non-number inputs
complete(testFile="calc.test.js", cases=4)
</example>

When done, call complete(testFile="<path>", cases=<number>).`,
    reminderFields: 'testFile (string), cases (number)',
    completeSchema: Type.Object({
      testFile: Type.String(),
      cases: Type.Number({ description: 'Number of test cases written' }),
    }),
    contextNeeds: [State.RESEARCH, State.LOCATE, State.DIAGNOSE],
  },

  [State.REFACTOR_PLAN]: {
    allowedTools: ['read', 'complete'],
    instruction: `Plan the refactoring without making any changes.

Available tools: read, complete. You do NOT have bash.
To read a file use the read tool, NOT cat or shell commands.
You may read multiple files in parallel.

<example>
focus: plan refactoring of config module to remove global singleton
assistant: [reads src/config/manager.ts and all files that import it in parallel]
→ identifies 5 files affected, plans 3-step extraction
complete(refactorSteps=["extract loadConfig() pure function","update 5 callers to use loadConfig()","delete ConfigManager class"], estimatedFiles=6)
</example>

When done, call complete(refactorSteps=["<step1>", ...], estimatedFiles=<n>).`,
    reminderFields: 'refactorSteps (array of strings), estimatedFiles (number)',
    completeSchema: Type.Object({
      refactorSteps: Type.Array(Type.String()),
      estimatedFiles: Type.Number(),
    }),
    contextNeeds: [State.RESEARCH, State.DIAGNOSE, State.LOCATE],
  },

  [State.ROLLBACK]: {
    allowedTools: ['read', 'write', 'bash', 'edit', 'complete'],
    instruction: `The system has already automatically restored the modified files to their original state.

Your job is to confirm which files were restored and call complete().

Available tools: read, write, complete.

Steps:
1. Read each file that was mentioned in the MODIFY step to confirm it has been restored
2. If a file looks wrong (still has the failed changes), use write to overwrite it with the correct original content
3. Call complete(restored=[...]) listing all confirmed files

<example>
focus: rollback changes to calc.js
assistant: [reads calc.js to confirm it is back to original state]
complete(restored=["calc.js"])
</example>

When done, call complete(restored=["<file1>", ...]).`,
    reminderFields: 'restored (array of file paths)',
    completeSchema: Type.Object({
      restored: Type.Array(Type.String({ description: 'File path that was restored' })),
    }),
    contextNeeds: [State.MODIFY, State.LOCATE],
  },

  [State.RESEARCH]: {
    allowedTools: ['read', 'grep', 'find', 'ls', 'webfetch', 'websearch', 'complete'],
    instruction: `Research and investigate the topic.

Available tools: read, ls, grep, find, webfetch, websearch, complete.
You do NOT have bash. To read a file use the read tool, NOT cat or shell commands.
To list a directory use ls with path parameter: ls(path="src") NOT ls("src") or ls src.
You may call multiple read/grep/find tools in parallel when they are independent.

Strategy:
- Understand/explain/report local code → use read/ls/grep/find to explore
- URL provided → webfetch it directly
- Web topic or error → websearch first, then webfetch top results
- Mixed (local + web) → read local files first, then supplement with web search

<example>
focus: explain how the auth module works
assistant: [reads src/auth/index.ts and src/auth/jwt.ts in parallel]
complete(report="auth module uses JWT: login() signs token with SECRET env var, verifyToken() validates it. Files: src/auth/index.ts, src/auth/jwt.ts")
</example>

<example>
focus: search for best practices for rate limiting in Express
assistant: [websearch "Express rate limiting best practices"] → [webfetches top 2 results]
complete(report="Use express-rate-limit package. Set windowMs=15min, max=100. https://expressjs.com/...")
</example>

You do NOT have edit or write tools. Do NOT attempt to modify or create files — read and report only.
Do NOT modify files.
If you read the code and find no bugs, or the existing implementation already satisfies all requirements, call complete(report="No issues found — code is already correct.") immediately. Do NOT invent bugs that are not present in the code.
As soon as you have gathered enough information, call complete(report="...") IMMEDIATELY.
Do NOT output a summary to the user before calling complete(). The complete() call IS your output.`,
    reminderFields: 'report (string)',
    completeSchema: Type.Object({
      report: Type.String({ description: 'Your findings, cite file paths or URLs' }),
    }),
  },

  [State.SETUP]: {
    allowedTools: ['read', 'bash', 'write', 'complete'],
    instruction: `Analyze this project and generate AGENTS.md.

Available tools: read, ls, grep, find, write, complete.
You may read multiple config files in parallel.

Steps:
1. Read package.json (or equivalent) for tech stack and scripts
2. Read config files in parallel: tsconfig.json, .eslintrc, .prettierrc, vitest.config.*
3. List src/ directory: ls(path="src")
4. Check for existing AGENTS.md, CLAUDE.md, README.md
5. Write AGENTS.md covering: tech stack, build/test/lint commands, conventions, key files

Rules:
- Target ~100-150 lines. Be concise.
- If AGENTS.md already exists, update it.
- The \`write\` tool is ONLY for creating or updating AGENTS.md. NEVER use write on source files (*.js, *.ts, *.py, *.java, etc.).

<example>
focus: analyze project and generate AGENTS.md
assistant: [reads package.json, tsconfig.json, vitest.config.ts in parallel] [lists src/]
→ writes AGENTS.md with tech stack (TypeScript, Vitest), test command (npx vitest run), key files
complete(created="AGENTS.md", summary="TypeScript + Vitest project, 8 core modules documented")
</example>

When done, call complete(created="AGENTS.md", summary="<what was captured>").`,
    completeSchema: Type.Object({
      created: Type.String({ description: 'File that was created or updated' }),
      summary: Type.String(),
    }),
  },
};
