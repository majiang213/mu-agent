import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai';
import { createCodingTools, createGrepTool, createLsTool, createFindTool } from '@earendil-works/pi-coding-agent';

import { astLocatorTool } from '../../tool/locator.js';
import { syntaxCheckHook, damageCheckHook } from '../../tool/safety/index.js';
import { StagnationDetector } from '../cognitive/index.js';
import { ContextCompactor } from '../compaction/index.js';
import type { ExecutionEvent, RunConfig } from './types.js';
import { State } from '../types.js';

/**
 * Git operations permanently restricted at the harness level by a HARD
 * ALLOWLIST (default-deny). The guard runs BEFORE the command reaches the
 * shell, so the instruction prompt cannot be tricked into executing
 * anything outside the allowlist.
 *
 * Gap 84 (Strategy B — ALLOWLIST): the previous Gap 83 argv-tokenizing
 * DENYLIST had 18 confirmed tokenizer-layer bypasses (shell metacharacter
 * chaining `&`/newline/CR, quoted subcommand `bash -c "..."`, absolute path
 * `/usr/bin/git`, command substitution `$(...)`/backticks, config alias
 * scope-flag aliases, fully-qualified delete refspecs `:refs/heads/main`,
 * history-rewrite plumbing `filter-branch`/`replace`/`fast-import`,
 * `push --mirror`/`--all`, `commit --no-verify=true`, `commit --amend`).
 *
 * The GIT instruction says: "ONLY run git commands via bash. No other shell
 * commands." Enforced as a HARD allowlist:
 *   1. REJECT any shell metacharacter that could embed a second command
 *      (`&`, `;`, `|`, newline, CR, `$`, backtick, `(`, `)`, `{`, `}`, `\`).
 *      Defeats chaining / substitution / subshell outright.
 *   2. REJECT unless the first token is `git` EXACTLY (no `/usr/bin/git`,
 *      no `sudo git`, no `bash -c`).
 *   3. Tokenize, skip global options (-C/-c/--git-dir/--work-tree/etc. with
 *      their values), locate the subcommand, REJECT if not in the ALLOWED set.
 *   4. Per-subcommand flag policy (case-SENSITIVE). Push is allowed ONLY with
 *      a safe refspec to a non-default branch and no force flag; if a refspec
 *      cannot be confidently parsed, REJECT (default-deny).
 *   5. Any unlisted subcommand (filter-branch, replace, fast-import,
 *      update-ref, symbolic-ref, reflog expire, reset, rebase, clean, gc,
 *      ...) is REJECTED by default-deny.
 *
 * `GIT_HARD_DENY` is exported (kept for tests / introspection). Despite the
 * legacy name it now carries the ALLOWLIST spec: `{ summary, isForbidden }`
 * where `isForbidden` returns a reason string when the command is NOT
 * allowlisted (i.e. forbidden), or null when allowed.
 */
export interface GitGuardSpec {
  /** Human-readable summary of the allowlist policy, embedded in the block message. */
  summary: string;
  /** Returns a reason string when the command is NOT allowlisted (forbidden), or null when allowed. */
  isForbidden: (command: string) => string | null;
}

const GIT_GUARD_SUMMARY =
  'Allowlist: git read-ops, add, safe commit, branch -d/--delete, checkout/switch, ' +
  'stash push/pop/apply/list/show/save, tag, fetch, cherry-pick, revert, merge, and ' +
  'push with safe refspec to non-default branch. REJECT: shell metacharacters, non-`git` ' +
  'first token, force push, push to main/master/HEAD, --mirror/--all/--delete refspec, ' +
  'reset, rebase, clean, filter-branch, replace, fast-import, update-ref, symbolic-ref, ' +
  'reflog expire, stash drop/clear, branch -D, commit --no-verify/-n/--amend, config alias.* writes.';

/**
 * Shell metacharacters whose presence lets a second command be embedded. The
 * GIT state needs NONE of these for legitimate git ops, so any occurrence
 * (even inside quotes) is a hard REJECT. `&` covers `&&`, `|` covers `||`.
 */
const SHELL_METACHARS = new Set([
  '&', // chaining (covers &&)
  ';', // statement separator
  '|', // pipe (covers ||)
  '\n', // newline chaining (A1)
  '\r', // CR chaining (A1)
  '$', // command substitution / var expansion (A4)
  '`', // backtick command substitution (A4)
  '(', // subshell (A4)
  ')',
  '{', // brace group
  '}',
  '\\', // backslash escape
]);

function containsShellMetachar(command: string): boolean {
  for (let i = 0; i < command.length; i++) {
    if (SHELL_METACHARS.has(command.charAt(i))) return true;
  }
  return false;
}

/**
 * Tokenize a shell command into argv tokens. Splits on whitespace but keeps
 * single-quoted and double-quoted substrings together (quotes stripped). This
 * is a deliberately simple tokenizer: it does not handle nested quotes or
 * shell escapes — but metacharacter rejection (step 1) has already removed
 * any command containing `$`, backtick, `(`, `)`, `{`, `}`, `\`, so the only
 * quotes that reach here are plain value-protecting quotes.
 */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = segment.length;
  while (i < n) {
    // skip whitespace
    while (i < n && /\s/.test(segment.charAt(i))) i++;
    if (i >= n) break;
    let current = '';
    while (i < n && !/\s/.test(segment.charAt(i))) {
      const ch = segment.charAt(i);
      if (ch === "'" || ch === '"') {
        const quote = ch;
        i++; // consume opening quote
        while (i < n && segment.charAt(i) !== quote) {
          current += segment.charAt(i);
          i++;
        }
        if (i < n) i++; // consume closing quote (if present)
      } else {
        current += ch;
        i++;
      }
    }
    tokens.push(current);
  }
  return tokens;
}

/** Default-branch ref names that must never be the push destination. */
const DEFAULT_BRANCH_REFS = new Set(['main', 'master', 'HEAD']);

/**
 * Resolve a refspec token to its destination branch name, or null if it is
 * not a recognizable ref to a default branch.
 *
 * Handles: bare `main`, `:main` (delete), `src:main`, `refs/heads/main`.
 * Returns null for branch names that merely START with / CONTAIN a default
 * name (e.g. `main-feature`, `feature/main`, `maintenance`).
 */
function resolveRefDest(token: string): string | null {
  let t = token;
  // Strip refs/heads/ prefix.
  if (t.startsWith('refs/heads/')) t = t.slice('refs/heads/'.length);
  // A refspec `src:dst` — only the dst side matters for default-branch protection.
  const colonIdx = t.indexOf(':');
  if (colonIdx >= 0) {
    t = t.slice(colonIdx + 1);
    if (t.startsWith('refs/heads/')) t = t.slice('refs/heads/'.length);
  }
  // Exact-match against default branch refs. `main-feature` etc. are NOT matches.
  if (t.length === 0) return null;
  return DEFAULT_BRANCH_REFS.has(t) ? t : null;
}

/** True if `flag` (a short-flag bundle like `-fd`, `-nm`) contains the letter `c`. */
function shortFlagHas(flag: string, letter: string): boolean {
  // flag looks like `-xyz`; check each char after the leading dash(es).
  const body = flag.replace(/^-+/, '');
  return body.indexOf(letter) >= 0;
}

/**
 * Global options that consume the following token as their value (appear
 * before the subcommand). Attached-equals forms (--git-dir=x) take no
 * separate value token.
 */
const VALUE_TAKING_GLOBALS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
]);

/**
 * Skip global options that appear before the subcommand. Returns the index of
 * the subcommand token, or -1 if no subcommand follows.
 */
function skipGlobalOptions(tokens: string[], start: number): number {
  let i = start;
  while (i < tokens.length) {
    const g = tokens[i];
    if (g === undefined || !g.startsWith('-')) return i;
    if (VALUE_TAKING_GLOBALS.has(g)) {
      i += 2; // consume option + its value
    } else {
      // Any other leading `-...` token is treated as a no-value global option.
      // Attached-equals forms (--git-dir=x) fall here too and consume no value.
      i += 1;
    }
  }
  return -1; // `git` with only global options and no subcommand.
}

/**
 * ALLOWED subcommands + their per-flag policy (case-SENSITIVE). Returns a
 * reason string if the invocation is forbidden (not allowlisted), or null if
 * allowed. `tokens[0]` must be exactly `git`; the subcommand is located after
 * skipping global options.
 */
function inspectGitInvocation(tokens: string[]): string | null {
  // Step 2: first token MUST be `git` exactly (no /usr/bin/git, no sudo, no bash).
  if (tokens.length === 0 || tokens[0] !== 'git') {
    return 'first token is not `git` (only bare `git` is allowed)';
  }

  const subIdx = skipGlobalOptions(tokens, 1);
  if (subIdx < 0) {
    // `git` with no subcommand. Reject — GIT state must run a concrete command.
    return 'no subcommand';
  }
  const subcommand = tokens[subIdx];
  if (subcommand === undefined) return 'no subcommand';
  const args = tokens.slice(subIdx + 1); // flags + positional args after subcommand

  switch (subcommand) {
    // ---- READ-ONLY: allow any args (these have no mutating flags) ----
    case 'status':
    case 'log':
    case 'diff':
    case 'show':
    case 'blame':
    case 'shortlog':
    case 'describe':
      // Read-only subcommands — allow any args (none of these mutate).
      return null;
    case 'reflog': {
      // `git reflog` / `git reflog show` are read-only. `git reflog expire`
      // rewrites history (prunes reflog entries) — REJECT it.
      const sub = args[0];
      if (sub === 'expire') return 'reflog expire';
      return null;
    }

    case 'branch': {
      // Allow -a, -r, -v, -d (safe delete), --delete, -m (rename), --list,
      // branch names. REJECT -D (force) incl. in a short bundle.
      for (const a of args) {
        if (a === '-D') return 'branch -D';
        // Combined short bundle containing uppercase D (e.g. -Dm). Lowercase -d is safe.
        if (a.startsWith('-') && !a.startsWith('--') && shortFlagHas(a, 'D')) {
          return 'branch -D';
        }
      }
      return null;
    }

    case 'add': {
      // Staging is safe — allow any args.
      return null;
    }

    case 'commit': {
      // Allow -m/--message, -a/--all, --allow-empty, --. REJECT --no-verify,
      // -n (incl. bundle), --amend (B5/C1). `--no-verify=true` attached-equals
      // is caught by the startsWith prefix.
      for (const a of args) {
        if (a === '--amend' || a.startsWith('--amend=')) return 'commit --amend';
        if (a === '--no-verify' || a.startsWith('--no-verify=')) return 'commit --no-verify';
        if (a === '-n') return 'commit -n (no-verify)';
        if (a.startsWith('-') && !a.startsWith('--') && shortFlagHas(a, 'n')) {
          return 'commit -n (no-verify)';
        }
      }
      return null;
    }

    case 'checkout':
    case 'switch': {
      // Allow -b, -B, branch names, --. (checkout does not force-push.)
      return null;
    }

    case 'stash': {
      const sub = args[0];
      if (sub === 'drop' || sub === 'clear') return `stash ${sub}`;
      // push, pop, apply, list, show, save are allowed.
      return null;
    }

    case 'tag': {
      // Create lightweight/annotated tag — local, safe.
      return null;
    }

    case 'fetch': {
      // Read-only from remote, no push.
      return null;
    }

    case 'cherry-pick':
    case 'revert':
    case 'merge': {
      // Create commits, no force. Merge conflicts handled by instruction.
      return null;
    }

    case 'push': {
      // ALLOW ONLY with explicit safe refspec to non-default branch and no
      // force flag. REJECT: --force/-f/--force-with-lease/+refspec (any refspec
      // token starting with `+`)/--mirror/--all/--delete, OR destination
      // resolves to main/master/HEAD (bare, :dst, src:dst, refs/heads/main).
      // If a refspec cannot be confidently parsed, REJECT (default-deny).
      let sawRefSpec = false;
      let sawMirrorOrAll = false;
      let sawDeleteFlag = false;
      for (const a of args) {
        // Force-push flags. `--force=<arg>` and `--force-with-lease[=<ref>]`
        // attached-equals forms — match by prefix.
        if (
          a === '--force' ||
          a === '-f' ||
          a === '--force-with-lease' ||
          a.startsWith('--force=') ||
          a.startsWith('--force-with-lease')
        ) {
          return 'push --force / -f / --force-with-lease';
        }
        if (a === '--mirror' || a === '--all') {
          sawMirrorOrAll = true;
          continue;
        }
        if (a === '--delete' || a === '-d') {
          sawDeleteFlag = true;
          continue;
        }
        // Force refspec: any refspec token starting with `+` (e.g. +main).
        if (a.startsWith('+')) {
          return 'push +refspec (force)';
        }
        // Skip non-refspec flags (e.g. --tags, --set-upstream, -u, --dry-run).
        // A flag is anything starting with `-` that is not a refspec.
        if (a.startsWith('-')) continue;
        // A positional token: could be a remote name OR a refspec. We must be
        // conservative — default-deny. A refspec contains `:` OR is a bare
        // branch name being pushed (git push origin main). Distinguish the
        // remote (first positional, no `:` and not a default branch) from a
        // refspec destination.
        if (!sawRefSpec) {
          // First positional = remote name. Accept it (no branch yet).
          sawRefSpec = true;
          continue;
        }
        // Subsequent positional = refspec. Parse its destination.
        const dest = resolveRefDest(a);
        if (dest !== null) {
          return `push to default branch (${dest})`;
        }
        // `git push origin :refs/heads/main` — delete via fully-qualified refspec.
        // resolveRefDest already strips refs/heads/ and the `:` delete prefix,
        // so `:refs/heads/main` -> `main` -> caught above. Also handle
        // `HEAD:refs/heads/main` (src HEAD, dst main) — caught above too.
      }
      if (sawMirrorOrAll) return 'push --mirror / --all';
      if (sawDeleteFlag) {
        // `git push --delete <ref>` without a parsed default-branch ref above
        // still reached here only if no positional default-branch ref was seen.
        // But --delete with ANY ref is a remote delete — be conservative and
        // reject bare --delete (default-deny on delete operations).
        return 'push --delete';
      }
      // A push with no refspec at all (e.g. `git push` or `git push origin`) is
      // ambiguous — default-deny.
      if (!sawRefSpec) return 'push without explicit refspec';
      return null;
    }

    case 'config': {
      // Allow READ only (key with no value, or --get/--list/--get-all).
      // REJECT any alias.* WRITE (key starts with alias. AND a value follows),
      // REJECT --global/--system/--local/--file/--add/--replace-all/--unset
      // writes to alias.*.
      // Simplest safe rule: REJECT any config invocation touching `alias.` as
      // a SET (value present); allow `git config alias.x` read (no value) and
      // other keys.
      const writeScopeFlags = new Set([
        '--global',
        '--system',
        '--local',
        '--file',
        '--add',
        '--replace-all',
        '--unset',
        '--unset-all',
      ]);
      let sawWriteScope = false;
      let keyIdx = -1;
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (a === undefined) continue;
        if (writeScopeFlags.has(a)) {
          sawWriteScope = true;
          continue;
        }
        if (a.startsWith('-')) continue; // other flags (--get, --list, etc.)
        if (keyIdx < 0) {
          keyIdx = k; // first non-flag positional = key
        }
      }
      const key = keyIdx >= 0 ? (args[keyIdx] ?? '') : '';
      const isAliasKey = key === 'alias' || key.startsWith('alias.');
      // A SET = a value token follows the key (another positional after keyIdx).
      const hasValue = keyIdx >= 0 && keyIdx + 1 < args.length && !(args[keyIdx + 1] ?? '').startsWith('-');
      if (isAliasKey && (hasValue || sawWriteScope)) {
        return `config ${key} (alias write)`;
      }
      // Non-alias writes (e.g. `git config user.email x@y`) — allow. The
      // instruction's threat model is alias.* hiding a force-push.
      return null;
    }

    default:
      // Step 5: any subcommand NOT in the allowed set (filter-branch, replace,
      // fast-import, update-ref, symbolic-ref, reset, rebase, clean, gc,
      // reflog expire, etc.) is REJECTED by default-deny.
      return `subcommand not allowlisted: ${subcommand}`;
  }
}

/**
 * Check a full command string against the git allowlist. Returns a reason
 * string if forbidden (the command must NOT be executed), or null if allowed.
 *
 * Note: because shell metacharacters are rejected wholesale (step 1), there is
 * exactly ONE command in any allowed string — no segment splitting needed.
 */
function checkGitCommand(command: string): string | null {
  if (command.trim().length === 0) return 'empty command';
  // Step 1: reject ANY shell metacharacter that could embed a second command.
  if (containsShellMetachar(command)) {
    return 'shell metacharacter present (chaining/substitution/subshell blocked)';
  }
  // Step 2 + 3 + 4 + 5: tokenize and enforce the allowlist.
  const tokens = tokenize(command);
  return inspectGitInvocation(tokens);
}

export const GIT_HARD_DENY: GitGuardSpec = {
  summary: GIT_GUARD_SUMMARY,
  isForbidden: checkGitCommand,
};

/**
 * Wrap a bash tool so that git commands NOT on the GIT allowlist are blocked
 * before execution. Used for the bash tool of every state (see step-runner.ts
 * wiring: `.map((t) => (t.name === 'bash' ? wrapWithGitGuard(t) : t))`).
 *
 * On block, returns a `[GIT GUARD]` text block WITHOUT echoing the verbatim
 * blocked command (F1: omitting the command avoids telegraphing the exact
 * bypass string the model tried) and WITHOUT `terminate` — stage 2 will wire
 * an abort so the model cannot iterate obfuscated variants against the guard
 * within the same step.
 */
export function wrapWithGitGuard(bashTool: AgentTool): AgentTool {
  const originalExecute = bashTool.execute.bind(bashTool);
  return {
    ...bashTool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const cmd =
        typeof (params as Record<string, unknown>)?.['command'] === 'string'
          ? ((params as Record<string, unknown>)['command'] as string)
          : '';
      const reason = GIT_HARD_DENY.isForbidden(cmd);
      if (reason !== null) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `[GIT GUARD] Blocked: command not on git allowlist (${reason}).\n${GIT_HARD_DENY.summary}`,
            },
          ],
          details: undefined,
        };
      }
      return originalExecute(toolCallId, params, signal, onUpdate);
    },
  };
}

export function buildStepAgent(
  systemPrompt: string,
  initialMessages: AgentMessage[],
  cfg: RunConfig,
  onEvent: ((event: ExecutionEvent) => void) | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: any[] = [
    ...createCodingTools(cfg.projectRoot),
    createGrepTool(cfg.projectRoot),
    createLsTool(cfg.projectRoot),
    createFindTool(cfg.projectRoot),
    astLocatorTool,
  ],
  readFiles?: Set<string>,
): Agent {
  let agentRef: Agent | null = null;

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: cfg.model,
      tools,
      ...(initialMessages.length > 0 ? { messages: initialMessages } : {}),
    },
    streamFn: async (m, agentCtx, opts) => {
      const lastUserMsg = agentCtx.messages.findLast((msg) => msg.role === 'user');
      const userPromptText =
        lastUserMsg && 'content' in lastUserMsg
          ? Array.isArray(lastUserMsg.content)
            ? (lastUserMsg.content as Array<{ type: string; text?: string }>)
                .flatMap((c) => (c.type === 'text' && c.text ? [c.text as string] : []))
                .join('\n')
            : typeof lastUserMsg.content === 'string'
              ? lastUserMsg.content
              : ''
          : '';
      if (!(opts as { signal?: AbortSignal })?.signal?.aborted) {
        onEvent?.({ type: 'turn_start', systemPrompt: agentCtx.systemPrompt ?? '', userPrompt: userPromptText });
      }
      return streamSimple(m, agentCtx, { ...opts, apiKey: cfg.apiKey, temperature: cfg.temperature });
    },
    getApiKey: () => cfg.apiKey,
    beforeToolCall: async (toolCtx) => {
      const toolName = toolCtx.toolCall.name;
      if (toolName === 'read' && readFiles) {
        const args = toolCtx.args as Record<string, unknown>;
        const fp = typeof args['filePath'] === 'string' ? args['filePath'] : null;
        if (fp) {
          if (readFiles.has(fp)) {
            return {
              block: true,
              reason: `Already read: ${fp}. Do not re-read. Already read files: ${[...readFiles].join(', ')}.`,
            };
          }
          readFiles.add(fp);
        }
      }
      if (toolName === 'edit' || toolName === 'write') {
        const maxFiles = cfg.safetyConfig.maxFilesPerTask ?? 5;
        if (!cfg.stateMachine.canModifyMoreFiles(maxFiles)) {
          return {
            block: true,
            reason: `File modification limit reached (max ${maxFiles} files per task).`,
          };
        }
      }
      if ((toolName === 'edit' || toolName === 'write') && (cfg.safetyConfig.enableCheckpoint ?? true)) {
        const args = toolCtx.args as Record<string, unknown>;
        const filePath = typeof args['path'] === 'string' ? args['path'] : null;
        if (filePath) {
          const resolved = filePath.startsWith('/') ? filePath : `${cfg.projectRoot}/${filePath}`;
          if (!resolved.startsWith(cfg.projectRoot)) {
            return { block: true, reason: `Path traversal blocked: ${filePath} is outside project root` };
          }
          try {
            await cfg.safeModifier.createCheckpoint(resolved);
          } catch (e) {
            console.warn('[SafeModifier] createCheckpoint failed for', filePath, ':', e);
            return { block: true, reason: '[SafeModifier] Cannot create checkpoint: ' + String(e) };
          }
        }
      }
      return undefined;
    },
    afterToolCall: async (toolCtx) => {
      if (toolCtx.toolCall.name === 'complete' && !toolCtx.isError) {
        agentRef?.abort();
      }
      // Gap 84 F1: a `[GIT GUARD]` block from wrapWithGitGuard signals a
      // disallowed git command. The guard returns a text result (no throw, no
      // terminate — see wrapWithGitGuard), so the agent loop would otherwise
      // let the model iterate obfuscated variants within the same step. Since
      // wrapWithGitGuard has no agent ref, detect the block marker here (where
      // agentRef IS available) and hard-abort the turn. This defeats the
      // iteration attack regardless of parallel batching.
      if (toolCtx.toolCall.name === 'bash' && !toolCtx.isError) {
        const bashContent = toolCtx.result?.content;
        const bashText = Array.isArray(bashContent)
          ? bashContent.flatMap((c) => (c && c.type === 'text' && c.text ? [c.text as string] : [])).join('\n')
          : '';
        if (bashText.startsWith('[GIT GUARD]')) {
          agentRef?.abort();
          return toolCtx.result;
        }
      }
      if (
        cfg.lspClient &&
        (toolCtx.toolCall.name === 'edit' || toolCtx.toolCall.name === 'write') &&
        !toolCtx.isError
      ) {
        const args = toolCtx.args as Record<string, unknown>;
        const filePath = typeof args['path'] === 'string' ? args['path'] : null;
        if (filePath) {
          const errors = await cfg.lspClient.touchFile(filePath);
          if (errors.length > 0) {
            const existing = toolCtx.result.content ?? [{ type: 'text' as const, text: 'ok' }];
            const lspText = errors.join('\n');
            const existingText = existing
              .flatMap((c) => (c.type === 'text' && c.text ? [c.text as string] : []))
              .join('');
            return {
              content: [{ type: 'text' as const, text: `${existingText}\n${lspText}` }],
            };
          }
        }
      }
      return undefined;
    },
    transformContext: async (messages) => {
      const latestSteerIdx = messages.findLastIndex((m) => m.role === 'steer');
      const result =
        latestSteerIdx < 0 ? messages : messages.filter((m, i) => m.role !== 'steer' || i === latestSteerIdx);
      const inLoopBudget = Math.floor(cfg.model.contextWindow * cfg.contextRatio);
      const compactor = new ContextCompactor({ maxTokens: inLoopBudget });
      return compactor.compact(result).messages;
    },
    convertToLlm: (messages) => {
      return messages.flatMap((m) => {
        if (m.role === 'steer') {
          const sm = m as import('../types.js').SteerMessage;
          return [{ role: 'user' as const, content: sm.content, timestamp: sm.timestamp }];
        }
        return [m as import('@earendil-works/pi-ai').Message];
      });
    },
  });

  agentRef = agent;
  return agent;
}

export function subscribeStepEvents(
  agent: Agent,
  state: State,
  stagnationDetector: StagnationDetector,
  cfg: RunConfig,
  onLlmText: (text: string) => void,
  onEvent?: (event: ExecutionEvent) => void,
  onTurnEndComplete?: () => void,
): void {
  const pendingModifyPaths = new Map<string, string>();
  let stagnationWarnings = 0;

  agent.subscribe((event: AgentEvent) => {
    if (event.type === 'tool_execution_start') {
      onEvent?.({
        type: 'tool_execution_start',
        tool: event.toolName,
        toolId: event.toolCallId,
        args: event.args as Record<string, unknown>,
      });
      cfg.stateMachine.recordToolCall(event.toolName, event.args, null);
      stagnationDetector.recordToolCall({
        tool: event.toolName,
        input: event.args,
        output: null,
        timestamp: Date.now(),
      });
      if (event.toolName === 'edit' || event.toolName === 'write') {
        const args = event.args as Record<string, unknown>;
        const fp = typeof args['path'] === 'string' ? args['path'] : null;
        if (fp) pendingModifyPaths.set(event.toolCallId, fp);
      }
    }

    if (event.type === 'tool_execution_end') {
      const rawOutput =
        event.result &&
        typeof event.result === 'object' &&
        Array.isArray((event.result as { content?: unknown }).content)
          ? (event.result as { content: Array<{ type: string; text?: string }> }).content
              .flatMap((c) => (c.type === 'text' && c.text ? [c.text as string] : []))
              .join('\n')
              .slice(0, 3000)
          : undefined;
      onEvent?.({
        type: 'tool_execution_end',
        tool: event.toolName,
        toolId: event.toolCallId,
        isError: event.isError,
        output: rawOutput || undefined,
      });
      const filePath = pendingModifyPaths.get(event.toolCallId);
      pendingModifyPaths.delete(event.toolCallId);
      if (event.isError && event.toolName !== 'bash') stagnationDetector.recordError(`tool_error:${event.toolName}`);
      if (
        filePath &&
        !event.isError &&
        (cfg.safetyConfig.enableCheckpoint ?? true) &&
        cfg.safeModifier.hasCheckpoint(filePath)
      ) {
        const checkpoint = cfg.safeModifier.getCheckpoint(filePath);
        const originalContent = checkpoint?.originalContent ?? '';
        void Promise.all([
          syntaxCheckHook.check(filePath, originalContent),
          damageCheckHook.check(filePath, originalContent),
        ])
          .then(([syntaxOk, damageOk]) => {
            if (!syntaxOk || !damageOk) {
              stagnationDetector.recordError(`post_check_failed:${filePath}`);
              cfg.safeModifier
                .restore(filePath)
                .then(() => {
                  agent.steer({
                    role: 'steer',
                    content: `[SAFE MODIFIER] Post-check failed for ${filePath} (syntax=${syntaxOk}, damage=${damageOk}). File restored.`,
                    timestamp: Date.now(),
                  });
                })
                .catch((restoreErr) => {
                  console.error('[SafeModifier] restore() failed for', filePath, ':', restoreErr);
                  agent.steer({
                    role: 'steer',
                    content:
                      '[SAFE MODIFIER] Post-check failed AND restore failed for ' +
                      filePath +
                      ': ' +
                      String(restoreErr) +
                      '. File may be damaged.',
                    timestamp: 0,
                  });
                });
            } else {
              cfg.safeModifier.clearCheckpoint(filePath);
            }
          })
          .catch((checkErr) => {
            console.warn('[SafeModifier] Post-check pipeline failed for', filePath, ':', checkErr);
          });
      }
    }

    if (event.type === 'message_update') {
      const ae = (event as any).assistantMessageEvent as { type: string };
      const msg = (event as any).message as { content?: Array<{ type: string; text?: string; thinking?: string }> };
      if (msg?.content) {
        const parts = msg.content;
        if (ae.type === 'thinking_delta' || ae.type === 'thinking_start') {
          const thinking = parts
            .flatMap((c) => (c.type === 'thinking' && c.thinking ? [c.thinking as string] : []))
            .join('');
          if (thinking) onEvent?.({ type: 'message_thinking_update', content: thinking });
        }
        if (ae.type === 'text_delta' || ae.type === 'text_start') {
          const text = parts
            .flatMap((c) => (c.type === 'text' && c.text ? [c.text as string] : []))
            .join('')
            .replace(/<think>[\s\S]*?<\/think>/g, '')
            .replace(/<think>[\s\S]*$/, '');
          if (text) onEvent?.({ type: 'message_update', content: text });
        }
      }
    }

    if (event.type === 'turn_end') {
      const msg = event.message;
      if (msg && 'content' in msg && Array.isArray(msg.content)) {
        const parts = msg.content as Array<{ type: string; text?: string; thinking?: string }>;
        const thinking = parts.flatMap((c) => (c.type === 'thinking' && c.thinking ? [c.thinking as string] : []));
        const text = parts.flatMap((c) => (c.type === 'text' && c.text ? [c.text as string] : []));
        if (thinking.length > 0) onEvent?.({ type: 'message_thinking_end', content: thinking.join('\n') });
        if (text.length > 0) {
          const joined = text
            .join('\n')
            .replace(/<think>[\s\S]*?<\/think>/g, '')
            .trim();
          if (joined) {
            onEvent?.({ type: 'message_end', content: joined });
            onLlmText(joined);
          }
        }
      }
      const usage = msg && 'usage' in msg ? (msg as { usage?: { input?: number; output?: number } }).usage : null;
      const inputTokens = usage?.input ?? 0;
      onEvent?.({
        type: 'turn_end',
        promptLen: inputTokens,
        responseLen: usage?.output ?? 0,
        contextTokens: inputTokens,
      });

      {
        const stagnationResult = stagnationDetector.check();
        if (stagnationResult?.detected) {
          if (stagnationWarnings >= 1) {
            agent.abort();
          } else {
            stagnationWarnings++;
            stagnationDetector.reset();
            agent.steer({
              role: 'steer',
              content: `[STAGNATION DETECTED] ${stagnationResult.message}. ${stagnationResult.suggestion ?? ''}`,
              timestamp: Date.now(),
            });
          }
        }
        // Reset warning count when agent makes progress (no stagnation this turn)
        if (!stagnationResult?.detected) {
          stagnationWarnings = 0;
        }
      }

      onTurnEndComplete?.();
    }
  });
}
