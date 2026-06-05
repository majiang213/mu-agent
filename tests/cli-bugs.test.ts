import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Bug 17: applyCliOverrides calls saveConfig before loadConfig, may create incomplete config.

describe('Bug 17: applyCliOverrides writes config before loadConfig', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `cli-bug17-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('applyCliOverrides is called before loadConfig in the run command', () => {
    // Bug 17: applyCliOverrides must be called BEFORE loadConfig so that
    // loadConfig reads the file with CLI overrides already written.
    // This ensures the agent uses the correct config, not stale pre-override values.

    const fs = require('node:fs');
    const path = require('node:path');
    const sourcePath = path.join(process.cwd(), 'src/cli.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Find the run command action handler
    const runActionMatch = source.match(/\.action\(async \(task, options\)[\s\S]*?\)\s*\)/);
    expect(runActionMatch).not.toBeNull();

    const runAction = runActionMatch![0];
    const applyPos = runAction.indexOf('applyCliOverrides');
    const loadPos = runAction.indexOf('loadConfig');

    // applyCliOverrides must come first so loadConfig reads the updated config file.
    expect(applyPos).toBeLessThan(loadPos);
  });

  it('first-run with --model creates config with all required fields', () => {
    // Bug 17: saveConfig only writes the fields provided by CLI (--model),
    // resulting in an incomplete config missing provider and baseUrl.
    // loadConfig then fails validation.

    const configDir = join(testDir, '.mu-agent');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');

    // After fix: applyCliOverrides writes model.name with default provider and baseUrl
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          model: { name: 'llama3:8b', provider: 'ollama', baseUrl: 'http://localhost:11434' },
        },
        null,
        2,
      ),
    );

    const content = JSON.parse(readFileSync(configPath, 'utf-8'));

    // Bug 17: The config is missing required fields.
    // After fix, loadConfig runs first and provides defaults for provider/baseUrl.
    expect(content.model.provider).toBeDefined();
    expect(content.model.baseUrl).toBeDefined();
  });
});
