# Contributing to µagent

Thanks for your interest in contributing! µagent is a research project exploring
how well small (7B/8B) local models can perform real coding tasks when given a
deterministic, state-machine-driven pipeline.

## Development Setup

Requirements: Node.js 24+, pnpm 10+, and (for e2e tests) a running
[Ollama](https://ollama.com) instance.

```bash
git clone https://github.com/majiang213/mu-agent.git
cd mu-agent
pnpm install
pnpm build        # compile TypeScript to dist/ (tsc)
pnpm test         # vitest (excludes e2e by default in CI)
pnpm lint
# type-check only (no emit): npx tsc --noEmit
```

## Workflow

1. **Open an issue first** for non-trivial changes — discuss the approach before
   writing code. This avoids wasted effort on misaligned directions.
2. **Plan before code**: for substantial work, sketch the approach (design →
   confirm → implement → test → doc-sync → commit) before writing code. This
   avoids wasted effort on misaligned directions.
3. **Tests required**: follow TDD where practical. Run `pnpm test` before
   requesting review. Do not delete or weaken failing tests — fix the code.
4. **One concern per PR**: keep PRs focused. Split unrelated changes.

## Code Style

- TypeScript, ESM (`"type": "module"`).
- No `as any` / `@ts-ignore` — narrow types properly.
- Immutable patterns: create new objects, don't mutate.
- Files: 200–400 lines typical, 800 max. Extract from large modules.
- Match the surrounding code's naming, density, and idioms.

Pre-commit hooks (husky + lint-staged) auto-fix formatting and lint on commit.

## Commit Messages

Conventional commits: `<type>: <description>` where type is one of
`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

Do not commit directly to `main` — use a feature branch.

## Reporting Issues

- Bugs: include reproduction steps, expected vs actual, and your
  `mu-agent config` output (redact any secrets).
- Security issues: see [SECURITY.md](./SECURITY.md) — do **not** open a public
  issue.
