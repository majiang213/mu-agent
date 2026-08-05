#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, saveConfig, ConfigNotFoundError } from './config/loader.js';
import { DEFAULT_CONFIG } from './config/defaults.js';
import { getLspStatuses } from './tool/lsp-status.js';
import type { Config } from './config/types.js';
import { isProviderName, PROVIDER_NAMES } from './provider/providers.js';
import { ReactAgent } from './core/agent/index.js';
import { SessionStore } from './core/session/store.js';

const program = new Command();

program.name('mu-agent').description('µagent — small-model coding agent with deterministic pipelines').version('1.0.0');

function parseProviderFlag(value: string): Config['model']['provider'] {
  if (!isProviderName(value)) {
    console.error(`Invalid provider "${value}" — must be one of: ${PROVIDER_NAMES.join(', ')}`);
    process.exit(1);
  }
  return value;
}

/** The -m/-p/-u flag vocabulary — declared ONCE (round-7, candidate 7). */
function addModelFlags(cmd: Command, mode: 'run' | 'save'): Command {
  const suffix = mode === 'save' ? ' (saved to .mu-agent/config.json)' : ' (this run only)';
  const verb = mode === 'save' ? 'Set ' : '';
  return cmd
    .option('-m, --model <model>', `${verb}model name${suffix}`)
    .option('-p, --provider <provider>', `${verb}provider: ${PROVIDER_NAMES.join(' | ')}${suffix}`)
    .option('-u, --base-url <url>', `${verb}base URL${suffix}`);
}

interface ModelFlagValues {
  model?: string;
  provider?: string;
  baseUrl?: string;
}

/** One if-chain over the three flags (was twinned: merge vs persist, round-7 C7). */
function cliModelUpdates(options: ModelFlagValues): Partial<Config['model']> {
  const updates: Partial<Config['model']> = {};
  if (options.model) updates.name = options.model;
  if (options.provider) updates.provider = parseProviderFlag(options.provider);
  if (options.baseUrl) updates.baseUrl = options.baseUrl;
  return updates;
}

/**
 * Per-run, in-memory config overrides. NEVER persisted — `mu-agent config`
 * is the only command that writes defaults (second-pass review, candidate 9).
 */
function mergeCliOverrides(config: Config, options: ModelFlagValues): Config {
  return { ...config, model: { ...config.model, ...cliModelUpdates(options) } };
}

/** Persist defaults (`config` command's whole job). saveConfig validates. */
function persistCliOverrides(options: ModelFlagValues): void {
  const modelUpdates = cliModelUpdates(options);
  if (Object.keys(modelUpdates).length > 0) {
    // Ensure provider and baseUrl have defaults when only --model is provided
    if (!modelUpdates.provider) modelUpdates.provider = DEFAULT_CONFIG.model.provider;
    if (!modelUpdates.baseUrl) modelUpdates.baseUrl = DEFAULT_CONFIG.model.baseUrl;
    saveConfig({ model: modelUpdates as Config['model'] });
  }
}

/**
 * run/tui shared prologue (round-7, C7): load config, apply this-run flags,
 * convert ConfigNotFoundError into a clean exit, ensure the code graph.
 */
async function resolveRunConfig(options: ModelFlagValues): Promise<Config> {
  let config: Config;
  try {
    config = mergeCliOverrides(loadConfig(), options);
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      console.error('\n' + err.message + '\n');
      process.exit(1);
    }
    throw err;
  }
  const { ensureGraphBuilt } = await import('./core/graph/builder.js');
  ensureGraphBuilt(process.cwd());
  return config;
}

addModelFlags(program.command('run').description('Run a coding task'), 'run')
  .argument('<task>', 'Task description')
  .action(async (task, options) => {
    try {
      const config = await resolveRunConfig(options);
      console.log(`🚀 Starting task: ${task}`);
      console.log(`🤖 Model: ${config.model.provider}/${config.model.name}`);
      console.log('\n📋 Executing task...\n');

      const { createConsolePresenter } = await import('./tui/console-presenter.js');
      const result = await new ReactAgent().run(task, config, createConsolePresenter());

      if (result.success) {
        console.log('\n✅ Task completed successfully');
      } else {
        console.log('\n❌ Task failed');
        process.exit(1);
      }
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

addModelFlags(program.command('config').description('Show or update current configuration'), 'save').action(
  (options) => {
    try {
      persistCliOverrides(options);
      const config = loadConfig();
      const lsp = getLspStatuses(process.cwd());
      const safe = {
        ...config,
        model: { ...config.model, apiKey: config.model.apiKey ? '***' : undefined },
      };
      console.log(JSON.stringify({ ...safe, lsp }, null, 2));
    } catch (err) {
      console.error('Config error:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  },
);

async function pickSession(themeName?: string): Promise<SessionStore | null> {
  const sessions = await SessionStore.list(process.cwd());
  if (sessions.length === 0) {
    console.error('No sessions found in .mu-agent/sessions/');
    return null;
  }

  const { ProcessTerminal, SelectList, Text, TUI } = await import('@earendil-works/pi-tui');
  const { selectTheme, C, initMuAgentTheme } = await import('./tui/theme.js');
  // First theme init wins (the singleton is idempotent) — it must carry the
  // configured name, or the later init in the tui action is a no-op (R8-B1).
  await initMuAgentTheme(themeName);
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const items = sessions.map((s) => ({
    value: s.filePath,
    label: new Date(s.created).toLocaleString(),
    description: s.preview,
  }));

  return new Promise((resolve, reject) => {
    const header = new Text(C.dim('  Select a session to resume  ↑↓ navigate  Enter confirm  Esc cancel'), 0, 0);
    tui.addChild(header);

    const list = new SelectList(items, 10, selectTheme);

    list.onSelect = (item) => {
      try {
        tui.stop();
        resolve(SessionStore.open(item.value, process.cwd()));
      } catch (err) {
        tui.stop();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    list.onCancel = () => {
      tui.stop();
      resolve(null);
    };

    tui.addChild(list);
    tui.setFocus(list);
    tui.start();
    tui.requestRender();
  });
}

addModelFlags(program.command('tui').description('Start interactive TUI mode'), 'run')
  .option('-c, --continue', 'Continue the most recent session')
  .option('--resume', 'Interactively select a session to resume')
  .action(async (options) => {
    const config = await resolveRunConfig(options);

    let sessionStore: SessionStore | undefined;

    if (options.continue) {
      const store = SessionStore.openLatest(process.cwd());
      if (store) {
        sessionStore = store;
      } else {
        console.error('No previous session found. Starting a new session.');
      }
    } else if (options.resume) {
      const picked = await pickSession(config.theme);
      if (!picked) {
        process.exit(0);
      }
      sessionStore = picked;
    }

    const { initMuAgentTheme } = await import('./tui/theme.js');
    await initMuAgentTheme(config.theme);
    const { createTuiApp } = await import('./tui/app.js');
    const app = createTuiApp({ config, sessionStore });
    app.start();
  });

program
  .command('setup')
  .description('Interactive setup wizard — configure model, LSP, and code graph')
  .action(async () => {
    const { createSetupWizard } = await import('./tui/setup.js');
    const wizard = createSetupWizard();
    await wizard.run();
  });

program.parse();
