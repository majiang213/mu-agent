# µagent

> English | [简体中文](./README.zh-CN.md)

A local ReAct coding agent built on the [pi](https://github.com/earendil-works/pi)
framework, designed for 7B/8B small models.

Reliably complete real coding tasks with local small models — no GPT, no API
key, runs entirely on your machine.

---

## Why small models need purpose-built design

Naively adapting an agent framework built for large models to 7B/8B models tanks
the success rate. The root cause isn't that small models are "dumb" — it's that
the task presentation doesn't fit them.

µagent's premise: **don't make the small model stronger; make the task fit the
small model.**

| Pain point | Large models (GPT, Claude) | Small models (7B/8B) | µagent's answer |
|------------|---------------------------|----------------------|-------------------|
| **Context window** | 128K–1M tokens, long tasks are easy | 8K–32K tokens, fills up after a few tool calls | Each step launches a fresh isolated Agent carrying only that step's context; steps pass structured summaries, not full message history |
| **Error recovery** | Analyzes failures, switches strategy, retries | Repeats the same failing approach, can't self-rescue | Real-time monitoring of the tool-call sequence; warns on repeated/no-progress, force-aborts the step on a second trigger |
| **Tool calling** | Picks tools accurately, formats rarely wrong | Often picks wrong tools, args malformed | Each state exposes only 2–4 necessary tools; the only way to exit a step is calling `complete()` validated against a schema |
| **Code location** | Reads the whole project in large context, infers target files | Context can't hold the project, guesses filenames | TypeScript AST pre-builds a call-graph index; BM25 recall + 2-hop graph expansion; exact file paths and line numbers injected into the prompt |
| **Task planning** | Produces a high-quality multi-step plan in one shot | Single-shot planning is low quality, misses key steps | Samples N independent plans in parallel, then a Synthesizer deliberates and merges their strengths into a plan better than any single attempt |

---

## Quick Start

### Requirements

- Node.js 20+
- [Ollama](https://ollama.ai), [Unsloth Studio](https://unsloth.ai) (local model
  runtimes), or an OpenAI-compatible API

### Install

```bash
npm install -g @majiang213/mu-agent
```

### Initialize

```bash
mu-agent setup
```

An interactive wizard guides you through model config, LSP install, and code-graph
build.

### Usage

**TUI interactive mode (recommended)**

```bash
mu-agent tui

# Resume the last session
mu-agent tui -c
```

| Key | Action |
|-----|--------|
| `Enter` | Run task |
| `Esc` | Interrupt current run |
| `Tab` | Expand/collapse thinking |
| `d` | Toggle debug mode |
| `Ctrl+C` | Quit |

**CLI one-shot**

```bash
mu-agent run "Fix the login bug in src/auth.ts"
```

**View and edit config**

```bash
mu-agent config                      # Show current config (incl. LSP status)
mu-agent config -m gemma4:e4b        # Switch model
```

Config lives at `.mu-agent/config.json` (project) or
`~/.config/mu-agent/config.json` (global). See
[`.mu-agent/config.example.json`](./.mu-agent/config.example.json) for a template.

---

## How it works

### Overall architecture

On each task, ReactAgent first has a REASON agent produce a step list, then
launches isolated Step agents in sequence. Each Agent instance is fully isolated
and carries only the tools its state allows.

```
user input
  │
  ▼
ReactAgent.run()
  │
  ├── 1. REASON agent (planning)
  │      Heavy Thinking: parallel-sample N plans → Synthesizer deliberation → best steps[]
  │      output: steps[] = [{state, focus}, ...]
  │
  ├── 2. Step-1 agent (e.g. LOCATE)
  │      tools: per-state allowlist
  │      output: ExecutedStep (with structured output)
  │
  └── 3. Step-N agent (e.g. MODIFY → VERIFY)
         input: original task + prior ExecutedStep summaries
         output: ExecutedStep
```

### Dynamic task planning

The REASON agent analyzes the input and outputs which steps to run and what each
does:

```
user: "Fix the login bug"
REASON output:
  steps=[
    {state:"LOCATE", focus:"find the login function in src/auth.ts"},
    {state:"MODIFY", focus:"fix the null-pointer exception"},
    {state:"VERIFY", focus:"run npm test to confirm it passes"}
  ]
```

Chitchat routes straight to ANSWER with no code operations:

```
user: "hello"
REASON output:
  steps=[{state:"ANSWER", focus:"respond to greeting"}]
```

If REASON decides no extra work is needed (e.g. task already done), it returns
empty steps and execution ends immediately.

### Heavy Thinking

For SMALL (≤9B) and MEDIUM (≤30B) models, the REASON stage auto-enables Heavy
Thinking, materially improving plan quality:

```
REASON stage (auto-enabled for SMALL/MEDIUM)
  │
  ├── parallel-sample N plans (each an isolated agent, temperature=0.7)
  │     Plan A: [LOCATE → MODIFY → VERIFY]
  │     Plan B: [DIAGNOSE → LOCATE → MODIFY → VERIFY]
  │     Plan C: [LOCATE → MODIFY → VERIFY]
  │
  └── Synthesizer deliberation
        merges strengths of all N plans → new steps[]
        Refinement loop: Judge evaluates (Jaccard > 0.85 or SAME → stop)
```

The Synthesizer doesn't just pick one candidate — it actively merges each plan's
strengths and can re-derive from scratch when every candidate is flawed.

---

## State reference

### State list

| State | Tools exposed | Purpose |
|-------|---------------|---------|
| REASON | complete | Dynamically plan execution steps (with Heavy Thinking); opens memory_search when needed |
| CLARIFY | complete | Ask the user to clarify task intent |
| LOCATE | read, ast_code_locator, complete | Pinpoint code to modify |
| MODIFY | read, edit, write, complete | Apply code changes |
| VERIFY | read, bash, complete | Verify changes (run tests/build) |
| DIAGNOSE | read, grep, bash, complete | Investigate bug root cause |
| ANSWER | complete | Pure Q&A, no file reads |
| RESEARCH | read, grep, find, ls, webfetch, websearch, complete | Research / explain / report |
| REVIEW | read, grep, complete | Code-quality review |
| TEST_WRITE | read, edit, write, complete | Write test cases |
| REFACTOR_PLAN | read, complete | Plan a refactor |
| ROLLBACK | read, write, bash, edit, complete | Roll back a bad change |
| SETUP | read, bash, write, complete | Project initialization |
| WRITE | read, write, complete | Create new files (README, config, etc.); does not modify existing code |
| PLAN | bash, read, complete | Two-level planning sub-planner: analyzes the situation and emits a sub-step list (read-only, performs no modifications) |
| GIT | bash, read, complete | Dedicated state for git operations (commit/branch/merge/push, etc.); the harness hard-blocks dangerous commands |
| DONE | — | Terminal state, task complete |

### Auto tier adaptation

The tier is auto-detected from Ollama's `general.parameter_count` field (custom /
unsloth providers specify it manually via `modelSize`, default LARGE):

```
SMALL  (≤9B)   → maxFilesPerTask=2, maxRetries=1, strictPlanning=true,  Heavy Thinking planCount=3
MEDIUM (≤30B)  → maxFilesPerTask=4, maxRetries=2, strictPlanning=true,  Heavy Thinking planCount=2
LARGE  (>30B)  → maxFilesPerTask=8, maxRetries=3, strictPlanning=false, Heavy Thinking disabled
```

### VERIFY-failure auto-retry

When VERIFY returns `passed=false`, the system re-plans with the failure context
rather than erroring out:

```
VERIFY failed
  → re-REASON with failure context → new steps[] (usually includes ROLLBACK or DIAGNOSE)
  → up to 2 retries
  → still failing → return success: false
```

### Two-level planning (subplan)

Some tasks have step counts/targets that can't be determined before execution
(e.g. splitting git commits, fixing all failing tests, batch API replacement).
REASON emits `{subplan:{analyzerState:"PLAN", focus:"<what to inspect, what plan to produce>"}}`;
`State.PLAN` (a read-only sub-planner, bash+read) runs and emits a sub-step list
that the harness recursively expands:

```
REASON → [{subplan:PLAN, focus:"analyze git changes, plan atomic commits"}]
  → PLAN step (bash/read analysis) → complete(steps=[GIT, GIT, ...])
  → harness expands and runs the sub-steps
```

- `analyzerState` is forced to `PLAN` (prevents forging another state to bypass guards)
- A PLAN's sub-steps never nest another subplan (prevents infinite recursion)
- An unparseable PLAN output marks the step failed (`{failed:true,...}`) — never silently "succeeds"
- Subplan semantics flow through the Heavy Thinking sampling/deliberation chain; a Synthesizer can merge subplans across candidates

### GIT state and the harness git guard

Git operations go through a dedicated `State.GIT` (bash+read+complete), avoiding
the semantic mismatch of borrowing MODIFY/VERIFY's bash. REASON routing: view git
history/diff → `[GIT]`, commit changes → `[GIT]`, fix-then-commit →
`[..., MODIFY, VERIFY, GIT]`.

**Harness-level hard allowlist (default-deny, cannot be bypassed by prompt
instructions):** before bash executes, `wrapWithGitGuard()` permits only
explicitly safe git subcommands (read-ops / add / safe commit / branch -d /
checkout / stash push/pop/apply / tag / fetch / cherry-pick / revert / merge /
push to a non-default branch) and rejects everything else. Specifically rejected:

- Shell metacharacters (`&`/`;`/`|`/newline/`$`/backtick/`()`) — defeats chaining / command substitution bypasses
- Non-`git` first token (`/usr/bin/git`, `bash -c`, `sudo git`)
- Force-push (`--force`/`-f`/`--force-with-lease`/`+refspec`), push to main/master/HEAD, `--mirror`/`--all`/`--delete` refspec
- History rewrites: `reset --hard`, `rebase`, `commit --amend`, `filter-branch`, `replace`, `fast-import`, `update-ref`, `symbolic-ref`
- `clean -f`, `stash drop/clear`, `branch -D`, `commit --no-verify/-n`, `reflog expire`, `config alias.*` writes

- On a merge conflict → run `git merge --abort`, then `complete(operation="merge", conflicts=[...])` to report (the harness has no conflict re-REASON path, so abort-and-report is required)
- Push is allowed only to non-default branches; never pushes to main/master
- The guard is applied to **every** bash-bearing state (not just GIT), preventing misroute bypasses

---

## Project structure

```
src/
├── cli.ts                    # CLI entry (run / tui / config / setup)
├── config/                   # Config load/save, LSP status detection
├── core/
│   ├── agent/                # ReactAgent (index / builder / step-runner / context / types)
│   ├── session/              # StateMachineAgent + SessionStore (JSONL persistence)
│   ├── heavy/                # Heavy Thinking: parallel sampling + Synthesizer deliberation + Refinement B/C
│   ├── memory/               # MemoryStore three-layer memory (episodes + semantic_facts + anchor injection)
│   ├── cognitive/            # StagnationDetector
│   ├── compaction/           # ContextCompactor (token-budget compaction)
│   ├── failure/              # FailureHandler (retry + escalation)
│   ├── graph/                # BM25 + Call-Graph code locator (SQLite)
│   ├── prompts/              # Per-state system prompts
│   ├── states.ts             # State config; tier derived from param count
│   └── types.ts              # State enum, Step, ExecutedStep, StepDirective, core types
├── provider/
│   └── model-info.ts         # Dynamic context-length + param-count fetch (ollama / custom / unsloth)
├── tool/
│   ├── complete.ts           # complete() tool (reads schema from STATE_REGISTRY)
│   ├── locator.ts            # AST locator tool
│   ├── lsp.ts                # LSP diagnostics client (auto-injected after edit/write)
│   ├── memory-search.ts      # memory_search tool
│   ├── webfetch.ts
│   ├── websearch.ts
│   └── safety/               # Checkpoint, line limits, syntax check
└── tui/
    ├── app.ts                # Main TUI (states, ESC interrupt, debug mode, session persistence)
    ├── metrics.ts            # MetricsCollector (token / duration stats)
    ├── setup.ts              # Interactive setup wizard (4 steps)
    └── theme.ts              # Color theme (per-state colors)
```

## Development

```bash
pnpm install
pnpm test            # vitest
pnpm build           # tsc
pnpm lint
```

Real Ollama integration tests (require Ollama running with a model loaded):

```bash
npx vitest run tests/e2e/ollama-real.test.ts
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution workflow and
[SECURITY.md](./SECURITY.md) for the security model and vulnerability reporting.

## Tech stack

| Dependency | Purpose |
|------------|---------|
| `@earendil-works/pi-agent-core` | Agent core (tool system, ReAct loop) |
| `@earendil-works/pi-ai` | LLM call layer (openai-completions compatible) |
| `@earendil-works/pi-coding-agent` | Coding tools (read / bash / edit / write) |
| `@earendil-works/pi-tui` | Terminal UI component library |
| `better-sqlite3` | Code-graph persistence (BM25 + Call Graph) + MemoryStore (episodic memory) |
| `commander` | CLI framework |
| `vitest` | Test framework |

---

## Design inspiration

- **[Agentless (ICSE 2025)](https://github.com/OpenAutoCoder/Agentless)**: deterministic pipelines beat LLM self-planning by 40%+; decompose complex tasks into constrained subtasks, each with a fixed toolset + dedicated prompt.
- **Agentless SWE-bench**: precise code location is the bottleneck for coding agents; BM25 recall + Call-Graph expansion pinpoints function line numbers with zero LLM calls.
- **Heavy Thinking**: parallel sampling + Synthesizer deliberation is inspired by [Large Language Monkeys](https://arxiv.org/abs/2407.21787) and [Self-consistency](https://arxiv.org/abs/2203.11171).

---

## License

[ISC](./LICENSE)
