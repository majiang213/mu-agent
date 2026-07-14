# Changelog

All notable changes to µagent will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-14

First public release. µagent is a local ReAct coding agent built on the
[pi](https://github.com/earendil-works/pi) framework, designed for 7B/8B small
models. Reliably complete real coding tasks with local small models — no GPT,
no API key, runs entirely on your machine.

### Added

- **100% local by design** — talks only to the LLM provider you configure
  (Ollama, Unsloth Studio, or your own OpenAI-compatible endpoint). No call to
  any third-party API, no hardcoded cloud backend, no telemetry.
- **Deterministic state-machine pipeline** — 17 states (REASON, CLARIFY, LOCATE,
  MODIFY, VERIFY, DIAGNOSE, ANSWER, RESEARCH, REVIEW, TEST_WRITE,
  REFACTOR_PLAN, ROLLBACK, SETUP, WRITE, PLAN, GIT, DONE). Each step launches a
  fresh isolated Agent carrying only that step's context.
- **Heavy Thinking** — for SMALL (≤9B) and MEDIUM (≤30B) models, the REASON
  stage parallel-samples N plans, then a Synthesizer deliberates and merges
  their strengths into a plan better than any single attempt. Adaptive sampling
  loop with Jaccard-based refinement stopping.
- **Per-state tool allowlist** — each state exposes only the 2–4 tools it
  needs; `complete()` is the sole exit signal, schema-validated.
- **SafeModifier checkpoints** — every `edit`/`write` is checkpointed first; a
  syntax + damage post-check auto-restores the file if the edit broke it. Path
  traversal outside the project root is blocked; per-task file/line limits cap
  blast radius.
- **GIT hard allowlist (default-deny)** — git commands run through a harness
  guard that rejects shell metacharacters and non-`git` first tokens, then
  permits only safe subcommands. Force-push, `reset --hard`, `rebase`,
  `commit --amend`, `filter-branch`, `branch -D`, `commit --no-verify`, and all
  unlisted subcommands are blocked before the shell. Applied to every
  bash-bearing state, not just GIT.
- **Two-level planning (subplan)** — REASON can emit a read-only `PLAN`
  sub-planner step that analyzes the situation and emits a sub-step list the
  harness recursively expands. Handles tasks with undetermined step counts
  (split commits, fix-all-tests, batch API replacement).
- **AST-based code locator** — TypeScript AST pre-builds a call-graph index;
  BM25 recall + 2-hop graph expansion pinpoints exact file paths and line
  numbers with zero LLM calls.
- **Multi-language LSP diagnostics** — 10 languages via a single
  `LANGUAGE_ENTRIES` source; diagnostics auto-injected after `edit`/`write`.
- **Stagnation detection** — real-time monitoring of the tool-call sequence;
  warns on repeated/no-progress, force-aborts the step on a second trigger.
- **Context compaction** — token-budget compaction keeps long tasks within the
  small-model context window.
- **VERIFY-failure auto-retry** — when VERIFY returns `passed=false`, the system
  re-plans with the failure context (up to 2 retries) rather than erroring out.
- **Three-layer memory store** — SQLite-backed episodic memory (episodes +
  semantic_facts + anchor injection) with `memory_search` tool.
- **Session persistence** — JSONL session store; resume last session (`-c`) or
  pick interactively (`--resume`).
- **Interactive setup wizard** — 4-step TUI guides model config, LSP install,
  and code-graph build.
- **Auto tier adaptation** — tier auto-detected from Ollama's
  `general.parameter_count`; SMALL/MEDIUM get stricter planning + Heavy
  Thinking, LARGE gets looser limits.

### Security

- Per-state tool allowlist (cannot be bypassed by prompt instructions).
- SafeModifier checkpoints with auto-rollback.
- GIT hard allowlist (default-deny) applied to all bash-bearing states.
- 100% local networking — no third-party API calls, no telemetry.
- See [SECURITY.md](./SECURITY.md) for the full threat model and private
  vulnerability reporting.

### Documentation

- Bilingual README (English + 简体中文).
- CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md.
- ISC license.
