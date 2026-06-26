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
 * Git operations permanently forbidden at the harness level (cannot be
 * bypassed by the model). The guard runs BEFORE the command reaches the
 * shell, so the instruction prompt cannot be tricked into executing these.
 *
 * Gap 83 (B+D): rewritten from a fragile regex array (which admitted
 * systematic bypasses: global-flag prefixes like `git -C /tmp push --force`,
 * force refspecs `git push origin +main`, refspec deletes `git push origin
 * :main`, false positives on `branch -d` from the case-insensitive `-D`
 * match, short `commit -n`, flag-between-args `reset --merge --hard`, and
 * plumbing/alias `update-ref`/`symbolic-ref`/`config alias.*`) to an
 * argv-tokenizing checker. The command is split into shell segments on
 * `&&`/`||`/`;`/`|`, each segment is tokenized (whitespace + simple quotes),
 * the `git` subcommand is located after skipping global options, and the
 * subcommand + its flags/args are inspected with case-sensitive flag logic.
 *
 * `GIT_HARD_DENY` is exported (kept for tests / introspection) but is no
 * longer a `RegExp[]`; it now carries the human-readable summary used in the
 * block message plus the checker function itself.
 */
export interface GitGuardSpec {
  /** Human-readable summary of forbidden operations, embedded in the block message. */
  summary: string;
  /** Returns a reason string when the command is forbidden, or null when allowed. */
  isForbidden: (command: string) => string | null;
}

const GIT_GUARD_SUMMARY =
  'Forbidden: push --force / -f / --force-with-lease / +refspec, push to main/master/HEAD ' +
  '(incl. :delete, --delete, refs/heads/main), reset --hard, rebase, clean -f, ' +
  'stash drop/clear, branch -D, commit --no-verify/-n, reflog expire, ' +
  'update-ref, symbolic-ref, config alias.*.';

/**
 * Tokenize a shell segment into argv tokens. Splits on whitespace but keeps
 * single-quoted and double-quoted substrings together (quotes stripped). This
 * is a deliberately simple tokenizer: it does not handle nested quotes or
 * shell escapes, which is sufficient for git CLI invocations the model emits.
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

/**
 * Split a full command string into shell segments on the chaining operators
 * `&&`, `||`, `;`, and `|`. A forbidden git op in ANY segment blocks the
 * whole command (chaining must not bypass the guard).
 */
function splitSegments(command: string): string[] {
  // Split on `&&`, `||`, `;`, `|` (single pipe, not `||`).
  // Do this with a single regex that matches any of the operators.
  return command
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Default-branch ref names that must never be the push destination. */
const DEFAULT_BRANCH_REFS = new Set(['main', 'master', 'HEAD']);

/**
 * Resolve a refspec token to its destination branch name, or null if it is
 * not a recognizable ref to a default branch.
 *
 * Handles: bare `main`, `:main` (delete), `src:main`, `+main` (force),
 * `refs/heads/main`, `+refs/heads/main`. Returns null for branch names that
 * merely START with a default name (e.g. `main-feature`, `maintenance`).
 */
function resolveRefDest(token: string): string | null {
  // Strip a single leading `+` (force-push prefix on the refspec).
  let t = token;
  if (t.startsWith('+')) t = t.slice(1);
  // Strip refs/heads/ prefix.
  if (t.startsWith('refs/heads/')) t = t.slice('refs/heads/'.length);
  // A refspec `src:dst` — only the dst side matters for default-branch protection.
  const colonIdx = t.indexOf(':');
  if (colonIdx >= 0) {
    t = t.slice(colonIdx + 1);
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
 * Inspect a single tokenized git invocation (tokens[0] === 'git', after global
 * option skipping the subcommand follows). Returns a reason string if the
 * invocation is forbidden, or null if it is allowed.
 */
function inspectGitInvocation(tokens: string[]): string | null {
  if (tokens.length === 0 || tokens[0] !== 'git') return null;

  // Skip global options that appear before the subcommand: -C <path>, -c <k=v>,
  // --git-dir <path>, --work-tree <path>, --namespace <ns>, --exec-path [path],
  // --bare, --no-pager, --literal-pathspecs, etc. Anything starting with `-`
  // before the subcommand is treated as a global option; if it is one of the
  // known value-taking options, also consume the following token as its value.
  const VALUE_TAKING_GLOBALS = new Set([
    '-C',
    '-c',
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--exec-path',
    '--config-env',
    '-P', // --no-pager takes no value; left here for completeness only
  ]);
  // Note: -P/--no-pager/etc. take no value; only the set above consume a value.
  const NO_VALUE_GLOBALS = new Set([
    '--bare',
    '--no-pager',
    '-p', // pager
    '--literal-pathspecs',
    '--glob-pathspecs',
    '--no-replace-objects',
    '--no-lazy-fetch',
  ]);

  let i = 1;
  while (i < tokens.length) {
    const g = tokens[i];
    if (g === undefined || !g.startsWith('-')) break;
    if (VALUE_TAKING_GLOBALS.has(g)) {
      i += 2; // consume option + its value
    } else if (NO_VALUE_GLOBALS.has(g)) {
      i += 1;
    } else {
      // Unknown global flag (e.g. --git-dir=x attached form, or any other).
      // Treat as a no-value option; do not skip the next token.
      i += 1;
    }
  }
  if (i >= tokens.length) return null; // `git` with no subcommand — nothing to block.

  const subcommand = tokens[i];
  const args = tokens.slice(i + 1); // flags + positional args after subcommand

  switch (subcommand) {
    case 'push': {
      let sawDeleteFlag = false;
      for (const a of args) {
        // Force-push flags. `--force=<arg>` and `--force-with-lease[=<ref>]`
        // are attached-equals forms of the same flags — match by prefix so the
        // `=...` value form cannot slip through.
        if (
          a === '--force' ||
          a === '-f' ||
          a === '--force-with-lease' ||
          a.startsWith('--force=') ||
          a.startsWith('--force-with-lease')
        ) {
          return 'push --force / -f / --force-with-lease';
        }
        if (a === '--delete' || a === '-d') {
          sawDeleteFlag = true;
          continue;
        }
        // Force refspec: any refspec token starting with `+` (e.g. +main, +refs/heads/main).
        if (a.startsWith('+')) {
          return 'push +refspec (force)';
        }
        // Default-branch destination: bare main/master/HEAD, :main (delete),
        // src:main, refs/heads/main, +main — but NOT main-feature / maintenance.
        if (resolveRefDest(a) !== null) {
          return `push to default branch (${resolveRefDest(a)})`;
        }
        // `--delete main` form: a default-branch ref appearing as a positional
        // arg after the --delete flag.
        if (sawDeleteFlag && DEFAULT_BRANCH_REFS.has(a.replace(/^refs\/heads\//, ''))) {
          return `push --delete to default branch (${a})`;
        }
      }
      return null;
    }
    case 'reset': {
      // --hard anywhere in reset args (e.g. `reset --merge --hard`, `reset --quiet --hard`).
      for (const a of args) {
        if (a === '--hard') return 'reset --hard';
      }
      return null;
    }
    case 'rebase': {
      // Any rebase rewrites history.
      return 'rebase';
    }
    case 'clean': {
      // -f, -fd, -xfd, --force.
      for (const a of args) {
        if (a === '--force') return 'clean --force';
        if (a.startsWith('-') && !a.startsWith('--') && shortFlagHas(a, 'f')) {
          return 'clean -f';
        }
      }
      return null;
    }
    case 'stash': {
      const sub = args[0];
      if (sub === 'drop' || sub === 'clear') return `stash ${sub}`;
      return null;
    }
    case 'branch': {
      // -D (uppercase) is force-delete; -d (lowercase) is safe delete — ALLOWED.
      // `--delete` long form is the same as -d (safe delete) — ALLOWED.
      for (const a of args) {
        if (a === '-D') return 'branch -D';
        // Combined short bundle containing uppercase D (e.g. -Dm). Lowercase -d is safe.
        if (a.startsWith('-') && !a.startsWith('--') && shortFlagHas(a, 'D')) {
          return 'branch -D';
        }
      }
      return null;
    }
    case 'commit': {
      for (const a of args) {
        if (a === '--no-verify') return 'commit --no-verify';
        // Standalone -n short flag, or combined short bundle containing n (e.g. -nm).
        if (a === '-n') return 'commit -n (no-verify)';
        if (a.startsWith('-') && !a.startsWith('--') && shortFlagHas(a, 'n')) {
          return 'commit -n (no-verify)';
        }
      }
      return null;
    }
    case 'reflog': {
      const sub = args[0];
      if (sub === 'expire') return 'reflog expire';
      return null;
    }
    case 'update-ref': {
      // Direct ref rewrite — any invocation.
      return 'update-ref';
    }
    case 'symbolic-ref': {
      // Moves HEAD — any invocation.
      return 'symbolic-ref';
    }
    case 'config': {
      // alias.* registration that could hide a force-push.
      const key = args[0] ?? '';
      if (key === 'alias' || key.startsWith('alias.')) {
        return `config ${key} (alias registration)`;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Check a full command string for forbidden git operations. Returns a reason
 * string if forbidden (the command must NOT be executed), or null if allowed.
 */
function checkGitCommand(command: string): string | null {
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    // Find a `git` token anywhere in the segment (e.g. `sudo git ...`, or just `git ...`).
    const gitIdx = tokens.indexOf('git');
    if (gitIdx < 0) continue;
    const reason = inspectGitInvocation(tokens.slice(gitIdx));
    if (reason !== null) return reason;
  }
  return null;
}

export const GIT_HARD_DENY: GitGuardSpec = {
  summary: GIT_GUARD_SUMMARY,
  isForbidden: checkGitCommand,
};

/**
 * Wrap a bash tool so that git commands matching GIT_HARD_DENY are blocked
 * before execution. Used only for State.GIT steps (see step-runner.ts).
 *
 * On block, returns a `[GIT GUARD]` text block WITHOUT echoing the verbatim
 * blocked command (F1: omitting the command avoids telegraphing the exact
 * bypass string the model tried).
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
              text: `[GIT GUARD] Blocked: forbidden git operation (${reason}).\n${GIT_HARD_DENY.summary}`,
            },
          ],
          details: undefined,
          // F1: terminate the turn so the model cannot iterate obfuscated
          // variants against the guard within the same step.
          terminate: true,
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
