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
- **Heavy Thinking (HT)** — for SMALL/MEDIUM models: N parallel REASON samples
  (sampler) → deliberation (synthesizer) → refinement (judge), before the real
  REASON step commits to a plan.
- **ReactAgent** — the facade: `run()` drives REASON → executeSteps → ANSWER.
- **ExecutionEvent** — the event union streamed from core to the TUI. The TUI's
  handler chain ends in an exhaustiveness check (unhandled variant = compile
  error).
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
  presentation prefixes, legacy prefix stripping at load.
- **reason-runner** (`src/core/agent/reason-runner.ts`) — the LLM-call engine:
  runStepAgent (prompt+retry) + runReasonAttempt. step-runner and the HT
  sampler both depend on it (no import cycle).
- **RunSetup** (`src/core/agent/setup.ts`) — builds everything a run needs
  (model probe, tool stack, env, LSP, memory, RunConfig) and disposes it
  (close()). run() is a pipeline over it.
- **isAbortError** (`src/core/agent/abort.ts`) — the one "user pressed Esc"
  predicate (name primary, 'aborted' fallback).
- **Two locators, disambiguated** — `CodeGraphLocator` (`core/graph/locator.ts`)
  is the harness's SQLite BM25+call-graph locator (one per run, in RunConfig);
  `astLocatorTool` (`tool/locator.ts`) is the model-facing AST search tool.
  IGNORE_DIRS (`core/graph/constants.ts`) is the one ignore list for both,
  the tree walker, and the graph builder.
- **MU_AGENT_DIR** (`config/defaults.ts`) — the one '.mu-agent' literal.

## Decisions worth not re-litigating

- Each step = isolated pi Agent instance (no shared message history).
- `steps = []` still runs the fixed ANSWER step (Gap 51).
- VERIFY never modifies files; failure → re-REASON, max 2 retries (Gap 38/47).
- No `State.RUN` — bash inside the harness bypasses the safety pipeline (Gap 70).
- `core/failure/` is a retry backoff helper, not a strategy framework — the old
  four-level RecoveryResult contract was dead at its only call site and was
  collapsed on 2026-07-30. Real recovery strategies would be new design work.
