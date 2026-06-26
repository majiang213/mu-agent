# Security Policy

## Supported Versions

Security fixes are applied to the latest released version on the `main` branch.

## Reporting a Vulnerability

µagent executes shell commands and modifies files on your local machine. If you
discover a vulnerability — especially in the tool execution path, the SafeModifier
checkpoint/rollback logic, the GIT guard allowlist, or any input-validation
boundary — please report it privately.

- **Do NOT open a public GitHub issue** for security vulnerabilities.
- Email: **majiang219@gmail.com**
- Include: a description of the issue, a minimal reproduction, and the impact.

You should receive an acknowledgement within 72 hours. Please allow reasonable
time for a fix to be developed before any public disclosure.

## Security Model

µagent is a **local, single-user** coding agent. Key boundaries:

- **SafeModifier**: checkpoints files before `edit`/`write`; restores on
  syntax/damage post-check failure. Path-traversal outside the project root is
  blocked.
- **GIT guard (allowlist)**: `State.GIT`'s bash tool is wrapped by a hard
  allowlist that rejects shell metacharacters, non-`git` first tokens, force
  pushes, pushes to `main`/`master`/`HEAD`, history rewrites (`reset --hard`,
  `rebase`, `filter-branch`, `commit --amend`), and unlisted subcommands. The
  guard runs **before** the command reaches the shell and cannot be bypassed by
  prompt instructions. See `src/core/agent/builder.ts`.
- **State machine**: each state exposes only the tools it needs; `complete()`
  is the sole exit signal with per-state schema validation.
- **No network exfiltration by design**: the agent talks only to the configured
  local LLM provider (Ollama / Unsloth / OpenAI-compatible base URL).

## Known Limitations

- The GIT guard allowlist is a **deny-by-default** policy; legitimate but
  non-allowlisted git subcommands will be rejected. This is intentional.
- Non-`GIT` states still expose unrestricted `bash`. The agent is intended to
  run on the user's own machine with the user's own shell trust.
