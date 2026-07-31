import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import type { Agent, AgentTool } from '@earendil-works/pi-agent-core';
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
import { buildModel, fetchOllamaParamCount, resolveApiKey } from '../../provider/model-info.js';
import { loadContext } from './context.js';
import type { EnvContext } from '../prompts/agent.js';
import type { RunConfig } from './types.js';

export interface RunSetup {
  cfg: RunConfig;
  memoryStore: MemoryStore;
  memoryIndex: string;
  memorySearchTool: AgentTool;
  pendingSummaries: Promise<void>;
  /** Dispose every subsystem whose lifecycle started here (LSP + memory db). */
  close(): void;
}

export interface AgentRegistryHooks {
  registerAgent: (a: Agent) => void;
  unregisterAgent: (a: Agent) => void;
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
  const [paramCount, model] = await Promise.all([
    config.model.provider === 'ollama'
      ? fetchOllamaParamCount(config.model.baseUrl, config.model.name)
      : Promise.resolve(config.model.modelSize != null ? config.model.modelSize * 1e9 : null),
    buildModel(config.model.name, config.model.provider, config.model.baseUrl, contextRatio, config.model.apiKey),
  ]);

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

  const memoryStore = MemoryStore.open(cwd, model);
  const pendingSummaries = memoryStore.processPendingSummaries().catch(() => {});
  const memoryIndex = memoryStore.index();
  const memorySearchTool = createMemorySearchTool(memoryStore);

  const cfg: RunConfig = {
    model,
    stateMachine,
    safetyConfig: config.safety ?? {},
    safeModifier: new SafeModifier(),
    env,
    temperature: config.model.temperature ?? DEFAULT_TEMPERATURE,
    contextRatio,
    apiKey: resolveApiKey(config.model),
    projectRoot: cwd,
    registerAgent: hooks.registerAgent,
    unregisterAgent: hooks.unregisterAgent,
    lspClient,
    locator,
    heavyThinking: config.heavyThinking,
  };

  return {
    cfg,
    memoryStore,
    memoryIndex,
    memorySearchTool,
    pendingSummaries,
    close: () => {
      lspClient.dispose();
      locator.close();
      memoryStore.close();
    },
  };
}
