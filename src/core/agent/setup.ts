import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import type { Agent, AgentTool } from '@earendil-works/pi-agent-core';
import { ModelRegistry, SessionManager } from '@earendil-works/pi-coding-agent';
import type { ExtensionRunner } from '@earendil-works/pi-coding-agent';
import { astLocatorTool } from '../../tool/locator.js';
import { SafeModifier } from '../../tool/safety/index.js';
import { webfetchTool } from '../../tool/webfetch.js';
import { websearchTool } from '../../tool/websearch.js';
import type { Config } from '../../config/types.js';
import { DEFAULT_TEMPERATURE, DEFAULT_CONTEXT_RATIO } from '../../config/defaults.js';
import { StateMachineAgent } from './state-machine.js';
import { LspClient } from '../../tool/lsp.js';
import { CodeGraphLocator } from '../graph/locator.js';
import { MemoryStore } from '../memory/index.js';
import { createMemorySearchTool } from '../../tool/memory-search.js';
import { buildModels, fetchOllamaParamCount, resolveApiKey } from '../../provider/model-info.js';
import { loadContext } from './context.js';
import { createExtensionHostState, loadExtensionRunner } from '../extensions/index.js';
import type { ExtensionHostState } from '../extensions/index.js';
import type { EnvContext } from '../prompts/agent.js';
import type { RunConfig } from './types.js';

export interface RunSetup {
  cfg: RunConfig;
  memoryStore: MemoryStore;
  memoryIndex: string;
  memorySearchTool: AgentTool;
  pendingSummaries: Promise<void>;
  /** Extension load failures (Gap 85-A) — run loop surfaces them as extension_notify. */
  extensionErrors: string[];
  /** Dispose every subsystem whose lifecycle started here (LSP + memory db). */
  close(): void;
}

export interface AgentRegistryHooks {
  registerAgent: (a: Agent) => void;
  unregisterAgent: (a: Agent) => void;
  /**
   * Model switch requested from inside a run (extension pi.setModel, Gap
   * 85-C). The app queues it and applies at run end (tier re-probe + HT
   * reconfigure + contextRatio recalc all happen in the next run's setup).
   * Returns false when no switch channel exists (tests, headless runs).
   */
  onModelSwitchRequest?: (modelId: string, provider: string) => boolean;
  /**
   * The run's pi SessionManager (Gap 85-B) — the TUI passes its SessionStore's
   * manager so extension appendEntry/setSessionName land in the live session.
   * Absent (tests, headless) → in-memory, non-persisted.
   */
  sessionManager?: SessionManager;
  /**
   * Shared extension runner + host (Gap 85-D): the TUI owns ONE long-lived
   * runner (extensions load once per app, slash commands/shortcuts/dialogs
   * work idle). Absent → per-run load (headless/tests), with close()
   * invalidating it. A shared runner is NEVER invalidated by a run.
   */
  extensions?: { runner?: ExtensionRunner; host: ExtensionHostState };
}

/**
 * The assembly seam of ReactAgent (round-5, candidate 1): production wires
 * buildRunSetup; facade tests inject a fake RunSetup instead of mocking the
 * assembly layer's import fan-out — same pattern as StepAgentDriver one
 * level down.
 */
export type RunSetupFactory = (config: Config, cwd: string, hooks: AgentRegistryHooks) => Promise<RunSetup>;

/**
 * Build everything a run needs: model probe, tool stack, env block, LSP,
 * memory, and the RunConfig itself. Previously assembled inline across ~90
 * lines of ReactAgent.run() — run() now reads as pipeline: setup → reason →
 * execute → answer → episode (second-pass review, candidate 4b).
 */
export async function buildRunSetup(config: Config, cwd: string, hooks: AgentRegistryHooks): Promise<RunSetup> {
  const contextRatio = config.model.contextRatio ?? DEFAULT_CONTEXT_RATIO;
  const [paramCount, built] = await Promise.all([
    config.model.provider === 'ollama'
      ? fetchOllamaParamCount(config.model.baseUrl, config.model.name)
      : Promise.resolve(config.model.modelSize != null ? config.model.modelSize * 1e9 : null),
    buildModels(config.model.name, config.model.provider, config.model.baseUrl, contextRatio, config.model.apiKey),
  ]);
  const { model, models, runtime: modelRuntime } = built;

  const stateMachine = new StateMachineAgent(
    config.model.name,
    [astLocatorTool, webfetchTool, websearchTool],
    paramCount,
    cwd,
  );

  const home = homedir();
  const cwdDisplay = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
  let isGitRepo: boolean;
  try {
    execSync('git rev-parse --git-dir', { stdio: 'ignore', cwd });
    isGitRepo = true;
  } catch {
    isGitRepo = false;
  }

  const env: EnvContext = {
    cwd: cwdDisplay,
    platform: process.platform,
    isGitRepo,
    date: new Date().toDateString(),
    projectContext: loadContext(cwd) ?? undefined,
  };

  const lspClient = new LspClient();
  await lspClient.init(cwd);

  const locator = new CodeGraphLocator(cwd);

  const memoryStore = MemoryStore.open(cwd, model, models);
  const pendingSummaries = memoryStore.processPendingSummaries().catch(() => {});
  const memoryIndex = memoryStore.index();
  const memorySearchTool = createMemorySearchTool(memoryStore);

  // Extensions (Gap 85-A): the runner + host live on the RunConfig so every
  // interception point (builder/tool_call/tool_result/context, observe
  // forwarding) sees them without new plumbing.
  // Gap 85-C: real ModelRegistry (ModelRuntime-backed) + providerActions.
  // Gap 85-D: the TUI passes its long-lived runner+host via hooks.extensions;
  // headless/tests fall through to a per-run load (invalidated at close).
  const shared = hooks.extensions;
  const extensionHost = shared?.host ?? createExtensionHostState();
  let extensionRunner = shared?.runner;
  let extensionErrors: string[] = [];
  if (!shared) {
    const modelRegistry = new ModelRegistry(modelRuntime);
    const sessionManager = hooks.sessionManager ?? SessionManager.inMemory(cwd);
    const loaded = await loadExtensionRunner(
      config,
      cwd,
      extensionHost,
      () => model,
      modelRegistry,
      sessionManager,
      {
        registerProvider: (name, pcfg) => modelRuntime.registerProvider(name, pcfg),
        registerNativeProvider: (p) => modelRuntime.registerNativeProvider(p),
        unregisterProvider: (name) => modelRuntime.unregisterProvider(name),
      },
      hooks.onModelSwitchRequest,
    );
    extensionRunner = loaded.runner;
    extensionErrors = loaded.errors;
  }

  const cfg: RunConfig = {
    model,
    models,
    stateMachine,
    safetyConfig: config.safety ?? {},
    safeModifier: new SafeModifier(),
    env,
    temperature: config.model.temperature ?? DEFAULT_TEMPERATURE,
    contextRatio,
    apiKey: resolveApiKey(config.model),
    projectRoot: cwd,
    registerAgent: (a) => {
      extensionHost.agents.add(a);
      hooks.registerAgent(a);
    },
    unregisterAgent: (a) => {
      extensionHost.agents.delete(a);
      hooks.unregisterAgent(a);
    },
    lspClient,
    locator,
    heavyThinking: config.heavyThinking,
    ...(extensionRunner ? { extensionRunner } : {}),
    extensionHost,
    ...(config.extensions ? { extensionsConfig: config.extensions } : {}),
  };

  return {
    cfg,
    memoryStore,
    memoryIndex,
    memorySearchTool,
    pendingSummaries,
    extensionErrors,
    close: () => {
      // Only a per-run-loaded runner is ours to invalidate — the TUI's shared
      // runner (85-D) outlives any single run.
      if (!shared) extensionRunner?.invalidate('run ended');
      lspClient.dispose();
      locator.close();
      memoryStore.close();
    },
  };
}
