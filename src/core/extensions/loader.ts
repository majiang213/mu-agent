import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ExtensionRunner, SessionManager, ModelRegistry } from '@earendil-works/pi-coding-agent';
import {
  discoverAndLoadExtensions,
  ExtensionRunner as ExtensionRunnerImpl,
  wrapRegisteredTools,
} from '@earendil-works/pi-coding-agent';
import { MU_AGENT_DIR, DEFAULT_EXTENSION_TOOL_STATES, EXTENSION_TOOL_BLACKLIST } from '../../config/defaults.js';
import type { Config } from '../../config/types.js';
import type { State } from '../types.js';
import type { ExtensionHostState } from './stubs.js';
import { buildExtensionActions, buildExtensionContextActions } from './stubs.js';

export interface ExtensionLoadResult {
  /** Undefined when disabled or nothing was discovered — zero overhead path. */
  runner?: ExtensionRunner;
  /** Load failures, surfaced to the TUI as extension_notify warnings. */
  errors: string[];
}

/**
 * Discover + load + bind extensions for one run (Gap 85-A).
 *
 * Discovery roots: `<cwd>/.mu-agent/extensions/` (project) +
 * `~/.mu-agent/extensions/` (global) + `config.extensions.paths[]`.
 * pi's own discoverAndLoadExtensions is reused, but its hardcoded
 * `<cwd>/.pi/extensions` scan is dodged by passing the .mu-agent dir AS the
 * cwd — mu-agent never implicitly loads the pi ecosystem (explicit bridge:
 * list a pi extension in `paths`). Config paths are pre-resolved to absolute
 * here because that cwd shift would otherwise rebase them.
 */
export async function loadExtensionRunner(
  config: Config,
  cwd: string,
  host: ExtensionHostState,
  getModel: () => import('@earendil-works/pi-ai').Model<'openai-completions'> | undefined,
  modelRegistry: ModelRegistry,
  sessionManager: SessionManager,
  providerActions?: {
    registerProvider: (name: string, config: import('@earendil-works/pi-coding-agent').ProviderConfig) => void;
    registerNativeProvider: (provider: import('@earendil-works/pi-ai').Provider) => void;
    unregisterProvider: (name: string) => void;
  },
  onModelSwitchRequest?: (modelId: string, provider: string) => boolean,
): Promise<ExtensionLoadResult> {
  const extCfg = config.extensions;
  if (extCfg?.enabled === false) return { errors: [] };

  const projectExtDir = join(cwd, MU_AGENT_DIR, 'extensions');
  const globalAgentDir = join(homedir(), MU_AGENT_DIR);
  const configuredPaths = [
    ...(existsSync(projectExtDir) ? [projectExtDir] : []),
    ...(extCfg?.paths ?? []).map((p) => (isAbsolute(p) ? p : resolve(cwd, p))),
  ];

  const result = await discoverAndLoadExtensions(configuredPaths, join(cwd, MU_AGENT_DIR), globalAgentDir);
  const errors = result.errors.map((e) => `${e.path}: ${e.error}`);
  if (result.extensions.length === 0) return { errors };

  const warn = (msg: string) => host.notify?.(msg, 'warning');
  // Gap 85-B: the SessionManager is REAL (the run's own session, shared with
  // the TUI's SessionStore) — appendEntry/setSessionName/setLabel work against
  // the live session tree. ModelRegistry is real since 85-C.

  const runner: ExtensionRunner = new ExtensionRunnerImpl(
    result.extensions,
    result.runtime,
    cwd,
    sessionManager,
    modelRegistry,
  );
  runner.bindCore(
    buildExtensionActions(warn, host, sessionManager, onModelSwitchRequest),
    buildExtensionContextActions(host, getModel),
    providerActions,
  );
  runner.onError((err) => {
    host.notify?.(`[extension ${err.event}] ${err.error}`, 'error');
  });
  return { runner, errors };
}

/**
 * Extension-registered tools eligible for a state (Gap 85-A decision ②):
 * the state must be in the configured allowlist (default
 * RESEARCH/DIAGNOSE/REVIEW/ANSWER) and never in the hard blacklist
 * (REASON/MODIFY/VERIFY — small-model discipline + checkpoint integrity).
 */
export function extensionToolsForState(
  runner: ExtensionRunner | undefined,
  state: State,
  configuredStates: string[] | undefined,
): AgentTool[] {
  if (!runner) return [];
  if ((EXTENSION_TOOL_BLACKLIST as readonly string[]).includes(state)) return [];
  const allowed = configuredStates ?? [...DEFAULT_EXTENSION_TOOL_STATES];
  if (!allowed.includes(state)) return [];
  return wrapRegisteredTools(runner.getAllRegisteredTools(), runner);
}
