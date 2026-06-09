/**
 * Automated fixture-based e2e tests.
 *
 * Observability:
 *  - Every ExecutionEvent is appended to agent-run.log (JSONL) in the temp dir.
 *  - After each run a structured summary is printed to stderr — always, not only on failure.
 *    The summary includes, per LLM turn: system prompt, user prompt, thinking, response, tool calls.
 *  - On failure the temp dir is preserved so the modified files can be inspected.
 *    On success the temp dir is deleted.
 *
 * Requires: Ollama running with the configured model.
 * Run individually: npx vitest run tests/e2e/fixtures.test.ts -t "calc"
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ReactAgent } from '../../src/core/agent/index.js';
import type { ExecutionEvent } from '../../src/core/agent/index.js';
import { loadConfig, ConfigNotFoundError } from '../../src/config/loader.js';
import type { Config } from '../../src/config/types.js';

// ── Config & Ollama guard ─────────────────────────────────────────────────────

let config: Config | null = null;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigNotFoundError)) throw err;
}

const BASE_URL = config?.model.baseUrl ?? '';
const FIXTURES_DIR = resolve(__dirname, '../fixtures');
const TEST_TIMEOUT = 300_000; // 5 min — real LLM calls (Heavy Thinking + up to 2 VERIFY retries)

async function isOllamaRunning(): Promise<boolean> {
  if (!config) return false;
  try {
    const url = BASE_URL.replace(/\/v1\/?$/, '');
    const res = await fetch(`${url}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

function isCommandAvailable(cmd: string): boolean {
  return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
}

// ── Core helpers ──────────────────────────────────────────────────────────────

/** Copy a fixture to a fresh temp dir; caller decides when to rmSync. */
function copyFixture(name: string): string {
  const src = join(FIXTURES_DIR, name);
  const dest = mkdtempSync(join(tmpdir(), `mu-agent-${name}-`));
  cpSync(src, dest, { recursive: true });
  return dest;
}

/** Spawn a command in cwd; returns success flag + combined stdout+stderr. */
function runCmd(cmd: string, args: string[], cwd: string): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 60_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ── Observability: event logger ───────────────────────────────────────────────

/**
 * Returns an onEvent callback that appends every ExecutionEvent as a JSONL
 * line to logPath. Errors are silently swallowed so logging never breaks tests.
 */
function createEventLogger(logPath: string): (event: ExecutionEvent) => void {
  const start = Date.now();
  return (event) => {
    try {
      appendFileSync(logPath, JSON.stringify({ ...event, _ts: Date.now(), _elapsed: Date.now() - start }) + '\n');
    } catch {
      // ignore
    }
  };
}

// ── Observability: log parser & printer ──────────────────────────────────────

interface ToolCall {
  name: string;
  args: unknown;
  output: string;
  isError: boolean;
}

interface TurnRecord {
  /** State the agent was in when this LLM turn started */
  state: string;
  systemPrompt: string;
  userPrompt: string;
  thinking: string;
  response: string;
  tools: ToolCall[];
  promptLen: number;
  responseLen: number;
  contextTokens: number;
}

function parseRunLog(logPath: string): TurnRecord[] {
  if (!existsSync(logPath)) return [];

  const lines = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  const turns: TurnRecord[] = [];
  let currentState = 'UNKNOWN';
  let currentTurn: TurnRecord | null = null;
  const pendingTools = new Map<string, { name: string; args: unknown }>();

  for (const line of lines) {
    let event: ExecutionEvent;
    try {
      event = JSON.parse(line) as ExecutionEvent;
    } catch {
      continue;
    }

    switch (event.type) {
      case 'state_change':
        currentState = event.to;
        break;

      case 'turn_start':
        currentTurn = {
          state: currentState,
          systemPrompt: event.systemPrompt,
          userPrompt: event.userPrompt,
          thinking: '',
          response: '',
          tools: [],
          promptLen: 0,
          responseLen: 0,
          contextTokens: 0,
        };
        break;

      case 'message_thinking_end':
        if (currentTurn) currentTurn.thinking = event.content;
        break;

      case 'message_end':
        if (currentTurn) currentTurn.response = event.content;
        break;

      case 'tool_execution_start':
        pendingTools.set(event.toolId, { name: event.tool, args: event.args ?? {} });
        break;

      case 'tool_execution_end': {
        const pending = pendingTools.get(event.toolId);
        if (currentTurn && pending) {
          currentTurn.tools.push({
            name: pending.name,
            args: pending.args,
            output: event.output ?? '',
            isError: event.isError,
          });
          pendingTools.delete(event.toolId);
        }
        break;
      }

      case 'turn_end':
        if (currentTurn) {
          currentTurn.promptLen = event.promptLen;
          currentTurn.responseLen = event.responseLen;
          currentTurn.contextTokens = event.contextTokens;
          turns.push(currentTurn);
          currentTurn = null;
        }
        break;
    }
  }

  // Push any incomplete turn (e.g., abort mid-run)
  if (currentTurn) turns.push(currentTurn);

  return turns;
}

function trunc(s: string, n: number): string {
  const flat = s.replace(/\n/g, '↵').replace(/\s{2,}/g, ' ');
  return flat.length > n ? flat.slice(0, n) + `…[+${flat.length - n}]` : flat;
}

/**
 * Print a full structured summary of a run to stderr.
 * Called after every run — on success and on failure.
 */
function printRunSummary(opts: {
  fixtureName: string;
  logPath: string;
  result: { success: boolean; output: string };
  verifyOut?: string;
  preservedDir?: string;
}): void {
  const { fixtureName, logPath, result, verifyOut, preservedDir } = opts;
  const passed = result.success && !verifyOut;
  const status = passed ? '✓ PASSED' : '✗ FAILED';
  const SEP = '═'.repeat(64);
  const sub = '─'.repeat(56);

  console.error(`\n${SEP}`);
  console.error(`FIXTURE: ${fixtureName}  ${status}`);
  if (preservedDir) {
    console.error(`  temp dir (preserved): ${preservedDir}`);
    console.error(`  log file:             ${logPath}`);
  }
  console.error(SEP);

  const turns = parseRunLog(logPath);
  if (turns.length === 0) {
    console.error('  (no turns recorded — log missing or agent did not start)');
  }

  let prevState = '';
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;

    // State header on transition
    if (t.state !== prevState) {
      console.error(`\n── STATE: ${t.state} ──`);
      prevState = t.state;
    }

    const tokens = t.promptLen > 0 ? `  (prompt=${t.promptLen} resp=${t.responseLen} ctx=${t.contextTokens})` : '';
    console.error(`  Turn ${i + 1}${tokens}`);

    // ── MODEL INPUT: system prompt ──────────────────────────────
    console.error(`    SYSTEM  (${t.systemPrompt.length} chars)`);
    // First 3 non-empty lines give a sense of the prompt structure
    const sysLines = t.systemPrompt
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .slice(0, 3);
    for (const l of sysLines) {
      console.error(`            ${trunc(l, 110)}`);
    }
    // Last 600 chars: state-specific instructions live at the end
    const tail = t.systemPrompt.slice(-600).trim();
    if (tail) {
      console.error(`            …(tail 600) ${trunc(tail, 500)}`);
    }

    // ── MODEL INPUT: user prompt ────────────────────────────────
    console.error(`    USER    ${trunc(t.userPrompt, 600)}`);

    // ── MODEL OUTPUT: thinking ──────────────────────────────────
    if (t.thinking) {
      console.error(`    THINK   ${trunc(t.thinking, 600)}`);
    }

    // ── MODEL OUTPUT: response ──────────────────────────────────
    if (t.response) {
      console.error(`    RESP    ${trunc(t.response, 600)}`);
    }

    // ── TOOL CALLS ──────────────────────────────────────────────
    for (const tool of t.tools) {
      const argsStr = trunc(JSON.stringify(tool.args), 200);
      const icon = tool.isError ? '✗' : '✓';
      console.error(`    TOOL ${icon}  ${tool.name}(${argsStr})`);
      if (tool.output) {
        console.error(`           → ${trunc(tool.output, 400)}`);
      }
    }
  }

  // ── Final result ──────────────────────────────────────────────
  console.error(`\n── FINAL ${sub}`);
  console.error(`  agent.success : ${result.success}`);
  console.error(`  agent.output  : ${trunc(result.output, 600)}`);

  if (verifyOut) {
    console.error(`\n── VERIFY CMD (FAILED) ${sub.slice(22)}`);
    console.error(trunc(verifyOut, 1200));
  }

  console.error(`${SEP}\n`);
}

// ── run helper ────────────────────────────────────────────────────────────────

async function runAgent(
  task: string,
  cwd: string,
): Promise<{ result: { success: boolean; output: string }; logPath: string }> {
  const logPath = join(cwd, 'agent-run.log');
  const agent = new ReactAgent();
  const result = await agent.run(task, config!, createEventLogger(logPath), undefined, { cwd });
  return { result, logPath };
}

/**
 * Print summary, then delete temp dir on success or preserve it on failure.
 * Call this in every test's finally block.
 */
function finalise(opts: {
  fixtureName: string;
  cwd: string;
  logPath: string;
  result: { success: boolean; output: string };
  verifyOut?: string;
}): void {
  const { fixtureName, cwd, logPath, result, verifyOut } = opts;
  const passed = result.success && !verifyOut;

  printRunSummary({
    fixtureName,
    logPath,
    result,
    verifyOut,
    preservedDir: passed ? undefined : cwd,
  });

  if (passed) {
    rmSync(cwd, { recursive: true, force: true });
  }
  // On failure: leave temp dir intact for manual inspection of modified files + agent-run.log
}

// ── Broken file content ───────────────────────────────────────────────────────

// calc.js: divide() missing zero-division guard, average() missing empty-array guard
const BROKEN_CALC_JS = `\
function add(a, b) { return a + b; }
function subtract(a, b) { return a - b; }
function multiply(a, b) { return a * b; }

function divide(a, b) {
  return a / b;
}

function average(numbers) {
  const sum = numbers.reduce((acc, n) => acc + n, 0);
  return sum / numbers.length;
}

module.exports = { add, subtract, multiply, divide, average };
`;

// data_processor.py: top_n_by sorts ascending instead of descending
const BROKEN_DATA_PROCESSOR_PY = readFileSync(
  join(FIXTURES_DIR, 'fixture-python-fix', 'data_processor.py'),
  'utf8',
).replace(
  /return sorted\(records, key=lambda r: r\[column\], reverse=True\)\[:n\]/,
  'return sorted(records, key=lambda r: float(r[column]), reverse=False)[:n]',
);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.skipIf(config === null)('Fixture E2E Tests (requires Ollama)', () => {
  beforeAll(async () => {
    const running = await isOllamaRunning();
    if (!running) {
      throw new Error(
        `Ollama is not running at ${BASE_URL}. ` +
          `Start Ollama and load model "${config?.model.name}" before running fixture tests.`,
      );
    }
  });

  // ── 1. fixture-calc ─────────────────────────────────────────────────────────
  it(
    'fixture-calc: fix missing divide/average guards so npm test passes',
    async () => {
      const cwd = copyFixture('fixture-calc');
      let result: { success: boolean; output: string } = { success: false, output: '' };
      let logPath = join(cwd, 'agent-run.log');
      let verifyOut: string | undefined;

      try {
        writeFileSync(join(cwd, 'calc.js'), BROKEN_CALC_JS);

        const pre = runCmd('npm', ['test', '--', '--no-coverage'], cwd);
        expect(pre.ok).toBe(false); // pre-condition: bugs must exist

        ({ result, logPath } = await runAgent(
          'Run `npm test`. Several tests are failing because of bugs in calc.js. ' +
            'Find the bugs and fix them so all tests pass.',
          cwd,
        ));
        expect(result.success).toBe(true);

        const post = runCmd('npm', ['test', '--', '--no-coverage'], cwd);
        if (!post.ok) verifyOut = post.out;
        expect(post.ok, `npm test still failing:\n${post.out}`).toBe(true);
      } finally {
        finalise({ fixtureName: 'fixture-calc', cwd, logPath, result, verifyOut });
      }
    },
    TEST_TIMEOUT,
  );

  // ── 2. fixture-todo-api ─────────────────────────────────────────────────────
  it(
    'fixture-todo-api: add missing DELETE /todos/:id route so npm test passes',
    async () => {
      const cwd = copyFixture('fixture-todo-api');
      let result: { success: boolean; output: string } = { success: false, output: '' };
      let logPath = join(cwd, 'agent-run.log');
      let verifyOut: string | undefined;

      try {
        const install = runCmd('npm', ['install', '--silent'], cwd);
        expect(install.ok, `npm install failed:\n${install.out}`).toBe(true);

        const pre = runCmd('npm', ['test', '--', '--no-coverage'], cwd);
        expect(pre.ok).toBe(false);

        ({ result, logPath } = await runAgent(
          'Run `npm test`. Tests expect a DELETE /todos/:id endpoint that removes the item ' +
            'and returns 200. That route is missing from server.js. ' +
            'Add it and make all tests pass.',
          cwd,
        ));
        expect(result.success).toBe(true);

        const post = runCmd('npm', ['test', '--', '--no-coverage'], cwd);
        if (!post.ok) verifyOut = post.out;
        expect(post.ok, `npm test still failing:\n${post.out}`).toBe(true);
      } finally {
        finalise({ fixtureName: 'fixture-todo-api', cwd, logPath, result, verifyOut });
      }
    },
    TEST_TIMEOUT,
  );

  // ── 3. fixture-python-fix ───────────────────────────────────────────────────
  it.skipIf(!isCommandAvailable('python3'))(
    'fixture-python-fix: fix ascending-sort bug in top_n_by so pytest passes',
    async () => {
      const cwd = copyFixture('fixture-python-fix');
      let result: { success: boolean; output: string } = { success: false, output: '' };
      let logPath = join(cwd, 'agent-run.log');
      let verifyOut: string | undefined;

      try {
        writeFileSync(join(cwd, 'data_processor.py'), BROKEN_DATA_PROCESSOR_PY);

        const pre = runCmd('python3', ['-m', 'pytest', '-q'], cwd);
        expect(pre.ok).toBe(false);

        ({ result, logPath } = await runAgent(
          'Run `python3 -m pytest -v`. There is a failing test. ' +
            'Find the bug in data_processor.py and fix it so all tests pass.',
          cwd,
        ));
        expect(result.success).toBe(true);

        const post = runCmd('python3', ['-m', 'pytest', '-q'], cwd);
        if (!post.ok) verifyOut = post.out;
        expect(post.ok, `pytest still failing:\n${post.out}`).toBe(true);
      } finally {
        finalise({ fixtureName: 'fixture-python-fix', cwd, logPath, result, verifyOut });
      }
    },
    TEST_TIMEOUT,
  );

  // ── 4. fixture-ts-types ─────────────────────────────────────────────────────
  it(
    'fixture-ts-types: fix three TypeScript type errors so tsc --noEmit exits 0',
    async () => {
      const cwd = copyFixture('fixture-ts-types');
      let result: { success: boolean; output: string } = { success: false, output: '' };
      let logPath = join(cwd, 'agent-run.log');
      let verifyOut: string | undefined;

      try {
        const pre = runCmd('npx', ['tsc', '--noEmit'], cwd);
        expect(pre.ok).toBe(false);

        ({ result, logPath } = await runAgent(
          'Run `npx tsc --noEmit`. There are TypeScript type errors in api.ts. ' +
            'Fix all of them without modifying types.ts. ' +
            'Make `npx tsc --noEmit` exit with code 0.',
          cwd,
        ));
        expect(result.success).toBe(true);

        const post = runCmd('npx', ['tsc', '--noEmit'], cwd);
        if (!post.ok) verifyOut = post.out;
        expect(post.ok, `tsc errors remain:\n${post.out}`).toBe(true);
      } finally {
        finalise({ fixtureName: 'fixture-ts-types', cwd, logPath, result, verifyOut });
      }
    },
    TEST_TIMEOUT,
  );

  // ── 5. fixture-java ─────────────────────────────────────────────────────────
  it.skipIf(!isCommandAvailable('mvn'))(
    'fixture-java: fix OrderService NullPointerException so mvn test passes',
    async () => {
      const cwd = copyFixture('fixture-java');
      let result: { success: boolean; output: string } = { success: false, output: '' };
      let logPath = join(cwd, 'agent-run.log');
      let verifyOut: string | undefined;

      try {
        const pre = runCmd('mvn', ['-q', 'test'], cwd);
        expect(pre.ok).toBe(false);

        ({ result, logPath } = await runAgent(
          'Run `mvn -q test`. One test fails with a NullPointerException in OrderService. ' +
            'Find and fix the bug so all Maven tests pass.',
          cwd,
        ));
        expect(result.success).toBe(true);

        const post = runCmd('mvn', ['-q', 'test'], cwd);
        if (!post.ok) verifyOut = post.out;
        expect(post.ok, `mvn test still failing:\n${post.out}`).toBe(true);
      } finally {
        finalise({ fixtureName: 'fixture-java', cwd, logPath, result, verifyOut });
      }
    },
    TEST_TIMEOUT,
  );

  // ── 6. fixture-auth ─────────────────────────────────────────────────────────
  it(
    'fixture-auth: security review identifies MD5 hashing and hardcoded secret',
    async () => {
      const cwd = copyFixture('fixture-auth');
      let result: { success: boolean; output: string } = { success: false, output: '' };
      let logPath = join(cwd, 'agent-run.log');
      let verifyOut: string | undefined;

      try {
        ({ result, logPath } = await runAgent(
          'Review auth.js for security vulnerabilities. ' + 'List each issue with its severity and a suggested fix.',
          cwd,
        ));
        expect(result.success).toBe(true);

        const out = result.output.toLowerCase();
        if (!out.match(/md5|weak.*hash|hash.*weak/) || !out.match(/secret|hardcod/)) {
          verifyOut = `Output missing expected keywords.\nOutput: ${result.output.slice(0, 600)}`;
        }
        expect(out).toMatch(/md5|weak.*hash|hash.*weak/);
        expect(out).toMatch(/secret|hardcod/);
      } finally {
        finalise({ fixtureName: 'fixture-auth', cwd, logPath, result, verifyOut });
      }
    },
    TEST_TIMEOUT,
  );

  // ── 7. fixture-readme ───────────────────────────────────────────────────────
  it(
    'fixture-readme: generate README.md covering crawler.py and stats.py',
    async () => {
      const cwd = copyFixture('fixture-readme');
      let result: { success: boolean; output: string } = { success: false, output: '' };
      let logPath = join(cwd, 'agent-run.log');
      let verifyOut: string | undefined;

      try {
        expect(existsSync(join(cwd, 'README.md'))).toBe(false);

        ({ result, logPath } = await runAgent(
          'Read crawler.py and stats.py, then write a README.md that explains: ' +
            'what each module does, the main public functions with their parameters, ' +
            'and a short usage example for each.',
          cwd,
        ));
        expect(result.success).toBe(true);

        if (!existsSync(join(cwd, 'README.md'))) {
          verifyOut = 'README.md was not created.';
        } else {
          const readme = readFileSync(join(cwd, 'README.md'), 'utf8');
          if (readme.length <= 200 || !readme.toLowerCase().match(/crawl/)) {
            verifyOut = `README.md too short or missing expected content. length=${readme.length}`;
          }
        }
        expect(existsSync(join(cwd, 'README.md'))).toBe(true);
        const readme = readFileSync(join(cwd, 'README.md'), 'utf8');
        expect(readme.length).toBeGreaterThan(200);
        expect(readme.toLowerCase()).toMatch(/crawl/);
      } finally {
        finalise({ fixtureName: 'fixture-readme', cwd, logPath, result, verifyOut });
      }
    },
    TEST_TIMEOUT,
  );
});
