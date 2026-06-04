#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, saveConfig, ConfigNotFoundError } from './config/index.js';
import { getLspStatus } from './config/lsp-status.js';
import type { Config } from './config/types.js';
import { ReactAgent } from './core/agent/index.js';
import { SessionStore } from './core/session/store.js';

const program = new Command();

program.name('mu-agent').description('µagent — small-model coding agent with deterministic pipelines').version('1.0.0');

function applyCliOverrides(options: { model?: string; provider?: string; baseUrl?: string }): void {
  const modelUpdates: Partial<Config['model']> = {};
  if (options.model) modelUpdates.name = options.model;
  if (options.provider) modelUpdates.provider = options.provider as Config['model']['provider'];
  if (options.baseUrl) modelUpdates.baseUrl = options.baseUrl;
  if (Object.keys(modelUpdates).length > 0) {
    // Ensure provider and baseUrl have defaults when only --model is provided
    if (!modelUpdates.provider) modelUpdates.provider = 'ollama';
    if (!modelUpdates.baseUrl) modelUpdates.baseUrl = 'http://localhost:11434';
    saveConfig({ model: modelUpdates as Config['model'] });
  }
}

program
  .command('run')
  .description('Run a coding task')
  .argument('<task>', 'Task description')
  .option('-m, --model <model>', 'Set model name (saved to .mu-agent/config.json)')
  .option('-p, --provider <provider>', 'Set provider (saved to .mu-agent/config.json)')
  .option('-u, --base-url <url>', 'Set base URL (saved to .mu-agent/config.json)')
  .action(async (task, options) => {
    try {
      let config;
      try {
        config = loadConfig();
        applyCliOverrides(options);
      } catch (err) {
        if (err instanceof ConfigNotFoundError) {
          console.error('\n' + err.message + '\n');
          process.exit(1);
        }
        throw err;
      }
      console.log(`🚀 Starting task: ${task}`);
      console.log(`🤖 Model: ${config.model.provider}/${config.model.name}`);
      console.log('\n📋 Executing task...\n');
      const result = await new ReactAgent().run(task, config);

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

program
  .command('config')
  .description('Show or update current configuration')
  .option('-m, --model <model>', 'Set model name (saved to .mu-agent/config.json)')
  .option('-p, --provider <provider>', 'Set provider (saved to .mu-agent/config.json)')
  .option('-u, --base-url <url>', 'Set base URL (saved to .mu-agent/config.json)')
  .action((options) => {
    try {
      applyCliOverrides(options);
      const config = loadConfig();
      const lsp = getLspStatus(process.cwd());
      console.log(JSON.stringify({ ...config, lsp }, null, 2));
    } catch (err) {
      console.error('Config error:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

async function pickSession(): Promise<SessionStore | null> {
  const sessions = SessionStore.list(process.cwd());
  if (sessions.length === 0) {
    console.error('No sessions found in .mu-agent/sessions/');
    return null;
  }

  const { ProcessTerminal, SelectList, Text, TUI } = await import('@mariozechner/pi-tui');
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const selectTheme = {
    selectedPrefix: (s: string) => `\x1b[32m${s}\x1b[0m`,
    selectedText: (s: string) => `\x1b[1m${s}\x1b[22m`,
    description: (s: string) => `\x1b[2m${s}\x1b[22m`,
    scrollInfo: (s: string) => `\x1b[2m${s}\x1b[22m`,
    noMatch: (s: string) => `\x1b[31m${s}\x1b[0m`,
  };

  const items = sessions.map((s) => ({
    value: s.filePath,
    label: new Date(s.created).toLocaleString(),
    description: s.preview,
  }));

  return new Promise((resolve) => {
    const header = new Text('\x1b[2m  选择要继续的会话  ↑↓ 选择  Enter 确认  Esc 取消\x1b[0m', 0, 0);
    tui.addChild(header);

    const list = new SelectList(items, 10, selectTheme);

    list.onSelect = (item) => {
      tui.stop();
      resolve(SessionStore.open(item.value, process.cwd()));
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

program
  .command('tui')
  .description('Start interactive TUI mode')
  .option('-m, --model <model>', 'Set model name (saved to .mu-agent/config.json)')
  .option('-p, --provider <provider>', 'Set provider (saved to .mu-agent/config.json)')
  .option('-u, --base-url <url>', 'Set base URL (saved to .mu-agent/config.json)')
  .option('-c, --continue', 'Continue the most recent session')
  .option('--resume', 'Interactively select a session to resume')
  .action(async (options) => {
    applyCliOverrides(options);
    let config;
    try {
      config = loadConfig();
    } catch (err) {
      if (err instanceof ConfigNotFoundError) {
        console.error('\n' + err.message + '\n');
        process.exit(1);
      }
      throw err;
    }

    let sessionStore: SessionStore | undefined;

    if (options.continue) {
      const store = SessionStore.openLatest(process.cwd());
      if (store) {
        sessionStore = store;
      } else {
        console.error('No previous session found. Starting a new session.');
      }
    } else if (options.resume) {
      const picked = await pickSession();
      if (!picked) {
        process.exit(0);
      }
      sessionStore = picked;
    }

    const { CodeGraphLocator } = await import('./core/graph/locator.js');
    try {
      const locator = new CodeGraphLocator(process.cwd());
      if (locator.needsRebuild()) {
        locator.buildGraph();
      }
    } catch (e) {
      void e;
    }

    const { createTuiApp } = await import('./tui/index.js');
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
