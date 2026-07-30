# CONTEXT — Domain Glossary

Domain language for this codebase. Use these terms in code, docs, and reviews.
Architecture vocabulary (module, interface, depth, seam, adapter, leverage,
locality) comes from the codebase-design skill; this file covers the *domain*.

## Core loop

- **State** — one step of the agent loop (REASON, LOCATE, MODIFY, VERIFY, ANSWER,
  RESEARCH, DIAGNOSE, REVIEW, WRITE, TEST_WRITE, REFACTOR_PLAN, ROLLBACK, PLAN,
  GIT, SETUP, CLARIFY, DONE). The planner (REASON) picks which states run.
- **StepDirective** — a planned step: a plain Step, `{ parallel: Step[] }`, or
  `{ subplan: SubplanSpec }`. Produced by REASON, executed by `executeSteps`.
- **ExecutedStep** — a step's structured result (`{ state, focus, output }`),
  injected into later steps per their `contextNeeds`.
- **complete()** — the tool every state must call to exit; its TypeBox schema is
  declared per-state in STATE_REGISTRY.
- **STATE_REGISTRY** — the single source for per-state facts: allowedTools,
  instruction, reminderFields, completeSchema, contextNeeds, and (since
  2026-07-30) readOnly / needsCodeContext / memoryIndex / memorySearchTool /
  verbPrefix. complete() args are validated against the same completeSchema
  the model sees (TypeBox Value.Check + reminderFields message).
- **step-outputs** (`src/core/step-outputs.ts`) — the read side of those
  shapes: parseEditedFiles / parseLocateFiles / parseVerifyOutput /
  parseKeyFinding / parseJsonObject / editedFilesOf. Total functions —
  degrade to [] or null, never throw (C12).
- **Heavy Thinking (HT)** — for SMALL/MEDIUM models: N parallel REASON samples
  (sampler) → deliberation (synthesizer) → refinement (judge), before the real
  REASON step commits to a plan. `planWithHeavyThinking`
  (`src/core/heavy/planner.ts`) owns the whole orchestration (phase-0 →
  sample → deliberate → clarify → fallbacks); `runReasonStep` is a tier gate
  plus a dispatch. Plan-set algebra (dedup/converged/new/jaccard/similar) has
  one home in `src/core/heavy/plan-set.ts` (C11).
- **ReactAgent** — the facade: `run()` drives REASON → executeSteps → ANSWER.
- **verify-retry** (`src/core/agent/verify-retry.ts`) — the VERIFY failure
  loop (re-REASON with failure context, auto-rollback, max 2 retries); one
  failRun() exit helper (C10).
- **ExecutionEvent** — the event union streamed from core to the TUI. The TUI's
  handler chain ends in an exhaustiveness check (unhandled variant = compile
  error). `state_change` phases are typed `RunPhase = State | 'IDLE' |
  'SAMPLING'` — pseudo-states are declared, not smuggled; rollback reports via
  `rollback_performed`, never a fabricated tool call.
- **SafeModifier** — file checkpoints before edit/write; rollback restores them.
  The checkpoint store is SHARED across parallel branches (never forked).
- **directives module** (`src/core/agent/directives.ts`) — one home for
  StepDirective: parse / flatten / fingerprint / format. Dedup, Jaccard
  similarity, and retry-loop detection all read one canonical fingerprint.
- **runReasonAttempt** (`step-runner.ts`) — the single REASON planning
  implementation; Heavy Thinking samples run it with a cloned state machine
  and throwOnFailure, so samples plan with the same memory injection and
  REMINDER retries as the real REASON step.
- **step-context** (`src/core/agent/step-context.ts`) — fork semantics for
  parallel branches (cloned state machine, SHARED checkpoint store) +
  parseEditedFiles + findOverlappingEdits (parallel_overlap event).
- **SafeModification** (`src/tool/safety/modification.ts`) — the post-edit
  protocol: syntax + damage check → restore-or-clear → steer message.
- **MemoryStore** — three-layer memory (episodes + entities + semantic facts)
  over SQLite. The deepened interface: open / writeEpisodeSync / index /
  search / searchById / processPendingSummaries / close. Episode queries
  project through the single episodeColumns() list.
- **RunPresenter** (`src/tui/presenter.ts`) — pure, terminal-free presentation:
  formatRunResult (run output → display), session message shaping without
  presentation prefixes, legacy prefix stripping at load, plus the shared
  formatting vocabulary (fmtTokens, fmtToolArgs, formatTaskSummary).
- **reason-runner** (`src/core/agent/reason-runner.ts`) — the LLM-call engine:
  runStepAgent (prompt+retry) + runReasonAttempt. step-runner and the HT
  sampler both depend on it (no import cycle).
- **RunSetup** (`src/core/agent/setup.ts`) — builds everything a run needs
  (model probe, tool stack, env, LSP, memory, RunConfig) and disposes it
  (close()). run() is a pipeline over it.
- **StateMachineAgent** (`src/core/agent/state-machine.ts`) — per-step tool
  gating (from STATE_REGISTRY), edit-file counting, model tier params.
  core/session/ contains only the SessionStore its name promises.
- **RunConfig honesty (C14)** — steps never mutate RunConfig: runStep /
  runReasonAttempt spread it per step, so retry-temperature escalation writes
  a step-local copy. File budget has one source: safety config
  (DEFAULT_MAX_FILES_PER_TASK); the ModelParams tier table was dead code.
- **git guard** (`src/tool/safety/git-guard.ts`) — the default-deny git
  allowlist (GIT_HARD_DENY + wrapWithGitGuard), wired onto every state's bash
  tool by applyStateToolPolicy. Lives in tool/safety/ beside SafeModifier (C8).
- **isAbortError** (`src/core/agent/abort.ts`) — the one "user pressed Esc"
  predicate (name primary, 'aborted' fallback).
- **Two locators, disambiguated** — `CodeGraphLocator` (`core/graph/locator.ts`)
  is the harness's SQLite BM25+call-graph locator (one per run, in RunConfig);
  `astLocatorTool` (`tool/locator.ts`) is the model-facing AST search tool.
  IGNORE_DIRS (`core/graph/constants.ts`) is the one ignore list for both,
  the tree walker, and the graph builder. Both extract symbols through ONE
  walker: `extractSymbols` (`core/graph/symbols.ts`) — union visiting,
  per-consumer filtering (qualified vs bare names, constructors) (C15).
- **MU_AGENT_DIR** (`config/defaults.ts`) — the one '.mu-agent' literal.
- **TUI modules** — `blocks.ts` (11 exported view classes, I/O-free
  constructors), `run-view.ts` (RunView: per-run view-model behind the
  RunViewHost seam — insertBeforeLoader/insertBeforeEditor/removeComponent/
  requestRender; headless-testable), `app.ts` (terminal orchestration shell,
  ~300 lines), `console-presenter.ts` (stdout adapter over ExecutionEvent for
  `mu-agent run` — the second adapter at the event seam) (C9, C13).
- **Entry-point assembly** — `ensureGraphBuilt(cwd, {force})`
  (`core/graph/builder.ts`) is the one graph-build call (tui / run / setup);
  `configPaths()` (`config/loader.ts`) is the one config-path knowledge;
  `selectTheme` (`tui/theme.ts`) is the one SelectList theme (C13).

## Decisions worth not re-litigating

- Each step = isolated pi Agent instance (no shared message history).
- `steps = []` still runs the fixed ANSWER step (Gap 51).
- VERIFY never modifies files; failure → re-REASON, max 2 retries (Gap 38/47).
- No `State.RUN` — bash inside the harness bypasses the safety pipeline (Gap 70).
- `core/failure/` is a retry backoff helper, not a strategy framework — the old
  four-level RecoveryResult contract was dead at its only call site and was
  collapsed on 2026-07-30. Real recovery strategies would be new design work.
