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
  instruction, reminderFields, completeSchema, contextNeeds. (Being deepened to
  also own readOnly/needsCodeContext/memory/verbPrefix/transition — candidate 1.)
- **Heavy Thinking (HT)** — for SMALL/MEDIUM models: N parallel REASON samples
  (sampler) → deliberation (synthesizer) → refinement (judge), before the real
  REASON step commits to a plan.
- **ReactAgent** — the facade: `run()` drives REASON → executeSteps → ANSWER.
- **ExecutionEvent** — the event union streamed from core to the TUI.

## Safety & memory

- **SafeModifier** — file checkpoints before edit/write; rollback restores them.
- **SafeModification** *(planned, candidates 3+5)* — the module owning the
  checkpoint → post-check → restore protocol (today smeared across builder.ts,
  step-runner.ts, agent/index.ts).
- **StepContext** *(planned, candidate 3)* — the module owning per-step mutable
  resources (SafeModifier forks, StagnationDetector, readFiles, retry config)
  with explicit fork/merge semantics for parallel branches.
- **MemoryStore** — three-layer memory (episodes + entities + semantic facts)
  over SQLite; injects a ~200-token index anchor into memory-capable states.

## Planned modules (architecture review 2026-07-30)

- **directives module** *(candidate 2)* — one home for StepDirective:
  parse / flatten / fingerprint / format, plus the unified `runReasonAttempt`.
- **RunPresenter** *(candidate 4)* — pure module in `src/tui/` converting
  ExecutionEvent + StateResult into view-models; app.ts only renders.

## Decisions worth not re-litigating

- Each step = isolated pi Agent instance (no shared message history).
- `steps = []` still runs the fixed ANSWER step (Gap 51).
- VERIFY never modifies files; failure → re-REASON, max 2 retries (Gap 38/47).
- No `State.RUN` — bash inside the harness bypasses the safety pipeline (Gap 70).
- `core/failure/` is a retry backoff helper, not a strategy framework — the old
  four-level RecoveryResult contract was dead at its only call site and was
  collapsed on 2026-07-30. Real recovery strategies would be new design work.
