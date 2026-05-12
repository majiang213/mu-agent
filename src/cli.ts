#!/usr/bin/env node
import { Command } from 'commander';
import { ConfigManager } from './config/manager.js';
import { TaskScheduler } from './core/agent.js';
import { StateMachineAgent } from './core/session.js';
import { createFailureHandler } from './core/failure/index.js';
import { createCognitiveGate } from './core/cognitive/index.js';
import { createContextCompactor } from './core/compaction/index.js';
import { createASTLocator } from './tool/locator.js';
import { createSafeModifier } from './tool/safety/index.js';

const program = new Command();

program
  .name('local-agent')
  .description('Local ReAct Agent with deterministic pipelines')
  .version('1.0.0');

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

      // Initialize config
      const configManager = ConfigManager.getInstance();
      const config = configManager.initialize();
      console.log('✅ Config loaded');

      // Initialize components
      const stateMachine = new StateMachineAgent(options.model);
      const failureHandler = createFailureHandler();
      const cognitiveGate = createCognitiveGate();
      const compactor = createContextCompactor();
      const astLocator = createASTLocator();
      const safeModifier = createSafeModifier();

      console.log('✅ Components initialized');

      // Create task scheduler
      const scheduler = new TaskScheduler();
      
      // Execute task
      console.log('\n📋 Executing task...\n');
      const result = await scheduler.executeTask(
        { id: '1', description: task, state: 'pending' },
        options.model,
        options.provider,
        options.baseUrl
      );

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
    const configManager = ConfigManager.getInstance();
    const config = configManager.initialize();
    console.log(JSON.stringify(config, null, 2));
  });

program
  .command('sysinfo')
  .description('Show system information')
  .action(async () => {
    const { getSysInfo } = await import('./sysinfo/collector.js');
    const info = getSysInfo();
    console.log('System Information:');
    console.log(`  Platform: ${info.platform}`);
    console.log(`  Arch: ${info.arch}`);
    console.log(`  CPU: ${info.cpuModel} (${info.cpuCount} cores)`);
    console.log(`  Memory: ${Math.round(info.totalMemory / 1024 / 1024 / 1024)}GB`);
    if (info.gpu) {
      console.log(`  GPU: ${info.gpu.model}`);
      console.log(`  VRAM: ${Math.round(info.gpu.vramTotal / 1024 / 1024 / 1024)}GB`);
    }
  });

program
  .command('tui')
  .description('Start interactive TUI mode')
  .option('-m, --model <model>', 'Model name', 'qwen3.5:9b')
  .option('-p, --provider <provider>', 'Provider', 'ollama')
  .option('-u, --base-url <url>', 'Base URL', 'http://localhost:11434')
  .action(async (options) => {
    const { createTuiApp } = await import('./tui/index.js');
    const app = createTuiApp({
      model: options.model,
      provider: options.provider,
      baseUrl: options.baseUrl,
    });
    app.start();
  });

program.parse();
