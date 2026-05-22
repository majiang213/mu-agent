#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, saveConfig } from './config/index.js';
import type { Config } from './config/types.js';
import { ReactAgent } from './core/agent/index.js';

const program = new Command();

program.name('local-agent').description('Local ReAct Agent with deterministic pipelines').version('1.0.0');

function applyCliOverrides(options: { model?: string; provider?: string; baseUrl?: string }): void {
  const modelUpdates: Partial<Config['model']> = {};
  if (options.model) modelUpdates.name = options.model;
  if (options.provider) modelUpdates.provider = options.provider as Config['model']['provider'];
  if (options.baseUrl) modelUpdates.baseUrl = options.baseUrl;
  if (Object.keys(modelUpdates).length > 0) {
    saveConfig({ model: modelUpdates as Config['model'] });
  }
}

program
  .command('run')
  .description('Run a coding task')
  .argument('<task>', 'Task description')
  .option('-m, --model <model>', 'Set model name (saved to .local-agent/config.json)')
  .option('-p, --provider <provider>', 'Set provider (saved to .local-agent/config.json)')
  .option('-u, --base-url <url>', 'Set base URL (saved to .local-agent/config.json)')
  .action(async (task, options) => {
    try {
      applyCliOverrides(options);
      const config = loadConfig();
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
  .option('-m, --model <model>', 'Set model name (saved to .local-agent/config.json)')
  .option('-p, --provider <provider>', 'Set provider (saved to .local-agent/config.json)')
  .option('-u, --base-url <url>', 'Set base URL (saved to .local-agent/config.json)')
  .action((options) => {
    try {
      applyCliOverrides(options);
      const config = loadConfig();
      console.log(JSON.stringify(config, null, 2));
    } catch (err) {
      console.error('Config error:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command('tui')
  .description('Start interactive TUI mode')
  .option('-m, --model <model>', 'Set model name (saved to .local-agent/config.json)')
  .option('-p, --provider <provider>', 'Set provider (saved to .local-agent/config.json)')
  .option('-u, --base-url <url>', 'Set base URL (saved to .local-agent/config.json)')
  .action(async (options) => {
    applyCliOverrides(options);
    const config = loadConfig();

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
    const app = createTuiApp({ config });
    app.start();
  });

program.parse();
