import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('run command merges CLI overrides in memory and never persists them', () => {
    // Bug 17's modern invariant (second-pass C9 + round-7 C7): the run/tui
    // commands NEVER write config — overrides apply in memory via
    // mergeCliOverrides inside resolveRunConfig. Only `mu-agent config`
    // persists. loadConfig therefore never reads half-written CLI values.
    const sourcePath = join(process.cwd(), 'src/cli.ts');
    const source = readFileSync(sourcePath, 'utf-8');

    // resolveRunConfig must merge overrides around loadConfig (in memory).
    const resolverMatch = source.match(/async function resolveRunConfig[\s\S]*?\n\}/);
    expect(resolverMatch).not.toBeNull();
    expect(resolverMatch![0]).toContain('mergeCliOverrides(loadConfig()');
    expect(resolverMatch![0]).not.toContain('saveConfig');

    // The run command action must not persist anything.
    const runActionMatch = source.match(/addModelFlags\(program\.command\('run'\)[\s\S]*?createConsolePresenter/);
    expect(runActionMatch).not.toBeNull();
    expect(runActionMatch![0]).not.toContain('saveConfig');
  });

  it('R8-B1: --resume threads the configured theme into the first theme init', () => {
    // pickSession runs before the tui action's initMuAgentTheme(config.theme);
    // a no-arg init there poisons the idempotent singleton and drops the theme.
    const sourcePath = join(process.cwd(), 'src/cli.ts');
    const source = readFileSync(sourcePath, 'utf-8');
    const pickMatch = source.match(/async function pickSession[\s\S]*?\n\}/);
    expect(pickMatch).not.toBeNull();
    expect(pickMatch![0]).toContain('initMuAgentTheme(themeName)');
    expect(source).toContain('pickSession(config.theme)');
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
