#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from './config/index.js';
import { ReactAgent } from './core/agent.js';

const program = new Command();

program.name('local-agent').description('Local ReAct Agent with deterministic pipelines').version('1.0.0');

program
  .command('run')
  .description('Run a coding task')
  .argument('<task>', 'Task description')
  .option('-m, --model <model>', 'Model name', 'qwen2.5:7b')
  .option('-p, --provider <provider>', 'Provider', 'ollama')
  .option('-u, --base-url <url>', 'Base URL', 'http://localhost:11434')
  .action(async (task, options) => {
    try {
      console.log(`🚀 Starting task: ${task}`);
      console.log(`🤖 Model: ${options.provider}/${options.model}`);
      console.log('\n📋 Executing task...\n');
      const result = await new ReactAgent().run(task, options.model, options.provider, options.baseUrl);

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
  .description('Show current configuration')
  .action(() => {
    try {
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
  .option('-m, --model <model>', 'Model name', 'qwen3.5:9b')
  .option('-p, --provider <provider>', 'Provider', 'ollama')
  .option('-u, --base-url <url>', 'Base URL', 'http://localhost:11434')
  .action(async (options) => {
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
    const app = createTuiApp({
      model: options.model,
      provider: options.provider,
      baseUrl: options.baseUrl,
    });
    app.start();
  });

program.parse();
