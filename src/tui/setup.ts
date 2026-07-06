import { Input, Loader, ProcessTerminal, SelectList, Text, TUI } from '@earendil-works/pi-tui';
import type { SelectItem } from '@earendil-works/pi-tui';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

import { saveConfig } from '../config/index.js';
import { getLspStatuses } from '../config/lsp-status.js';
import { fetchOllamaModels, fetchCustomModels, fetchUnslothModels } from '../provider/model-info.js';
import type { Config } from '../config/types.js';
import { C } from './theme.js';

// ─── SelectList theme (matches project style) ────────────────────────────────

const selectTheme = {
  selectedPrefix: (s: string) => C.ok(s),
  selectedText: (s: string) => `\x1b[1m${s}\x1b[22m`,
  description: (s: string) => C.dim(s),
  scrollInfo: (s: string) => C.dim(s),
  noMatch: (s: string) => C.err(s),
};

// ─── SetupWizard ─────────────────────────────────────────────────────────────

export class SetupWizard {
  private tui: TUI;
  private step = 1;
  private readonly totalSteps = 4;
  private stepComponents: Text[] = [];
  private graphBuilt: boolean | null = null;

  constructor() {
    const terminal = new ProcessTerminal();
    this.tui = new TUI(terminal);
  }

  async run(): Promise<void> {
    this.tui.start();

    process.on('SIGINT', () => {
      this.tui.stop();
      process.exit(0);
    });

    this.tui.addInputListener((data) => {
      if (data === '\x03') {
        this.tui.stop();
        process.exit(0);
      }
      return undefined;
    });

    this.renderHeader();

    await this.stepModel();
    await this.stepLsp();
    await this.stepGraph();
    this.stepDone();

    await setImmediate();
    this.tui.stop();
    process.exit(0);
  }

  // ─── Header ────────────────────────────────────────────────────────────────

  private headerComp: Text | null = null;

  private renderHeader(): void {
    if (this.headerComp) {
      this.tui.removeChild(this.headerComp);
    }
    this.headerComp = new Text(C.dim(`  mu-agent setup`) + '  ' + C.dim(`Step ${this.step}/${this.totalSteps}`), 0, 0);
    this.tui.addChild(this.headerComp);
    this.tui.requestRender();
  }

  // ─── Step 1: Model config ──────────────────────────────────────────────────

  private async loadExistingModel(): Promise<Partial<Config['model']>> {
    const paths = [
      join(process.cwd(), '.mu-agent', 'config.json'),
      join(homedir(), '.config', 'mu-agent', 'config.json'),
    ];
    for (const p of paths) {
      if (existsSync(p)) {
        try {
          const parsed = JSON.parse(await readFile(p, 'utf-8')) as Partial<Config>;
          if (parsed.model) return parsed.model;
        } catch {
          // ignore malformed file
        }
      }
    }
    return {};
  }

  private async stepModel(): Promise<void> {
    this.step = 1;
    this.renderHeader();

    const existing = await this.loadExistingModel();

    this.addStepText('\n  ' + C.ok('Model config'));
    this.addStepText('\n  Provider');

    let provider: string = existing.provider ?? 'ollama';
    const providerItems: SelectItem[] = [
      { value: 'ollama', label: 'ollama', description: 'Local Ollama server' },
      { value: 'unsloth', label: 'unsloth', description: 'Unsloth Studio (default: localhost:8888)' },
      { value: 'custom', label: 'custom', description: 'OpenAI-compatible API' },
    ];
    const defaultProviderIdx = providerItems.findIndex((i) => i.value === provider);
    const selectedProvider = await this.waitForSelect(providerItems, defaultProviderIdx < 0 ? 0 : defaultProviderIdx);
    if (selectedProvider) provider = selectedProvider.value;

    const baseUrlDefault =
      provider === 'ollama' ? 'http://localhost:11434' : provider === 'unsloth' ? 'http://localhost:8888' : '';
    this.addStepText(`\n  Provider: ${C.ok(provider)}\n  Base URL:`);
    const baseUrl = await this.waitForInput(existing.baseUrl ?? baseUrlDefault);

    const modelName = await this.pickModel(provider, baseUrl, existing.name);

    let modelSize: number | undefined;
    if (provider === 'custom' || provider === 'unsloth') {
      this.addStepText(
        `\n  Model size (unit: B, e.g. 7 means 7B; affects Heavy Thinking and constraint strength)\n  Leave blank to skip (treated as large model):\n  Model size (B):`,
      );
      const raw = await this.waitForInput(existing.modelSize != null ? String(existing.modelSize) : '');
      const trimmed = raw.trim();
      const parsed = trimmed === '' ? NaN : Number(trimmed);
      if (Number.isFinite(parsed) && parsed > 0) modelSize = parsed;
    }

    saveConfig({
      model: {
        provider: provider as 'ollama' | 'custom' | 'unsloth',
        name: modelName,
        baseUrl,
        ...(modelSize != null ? { modelSize } : {}),
      },
    });

    this.clearStep();
  }

  private async pickModel(provider: string, baseUrl: string, existingName?: string): Promise<string> {
    const loader = new Loader(
      this.tui,
      (s) => C.pending(s),
      (s) => C.dim(s),
      'Fetching model list...',
    );
    this.tui.addChild(loader);
    loader.start();
    this.tui.requestRender();

    const models =
      provider === 'ollama'
        ? await fetchOllamaModels(baseUrl)
        : provider === 'unsloth'
          ? await fetchUnslothModels(baseUrl)
          : await fetchCustomModels(baseUrl);

    loader.stop();
    this.tui.removeChild(loader);

    if (models.length === 0) {
      this.addStepText(`\n  ${C.dim('Could not fetch model list, enter manually')}\n  Model name:`);
      return this.waitForInput(existingName ?? '');
    }

    const items: SelectItem[] = models.map((m) => ({
      value: m.name,
      label: m.name,
      description: `context: ${Intl.NumberFormat('en-US').format(m.contextLength)}`,
    }));
    this.addStepText('\n  Select model:');
    this.tui.requestRender();

    const defaultIdx = existingName ? items.findIndex((i) => i.value === existingName) : 0;
    const selected = await this.waitForSelect(items, defaultIdx < 0 ? 0 : defaultIdx);

    if (selected) return selected.value;

    this.addStepText(`\n  Model name:`);
    return this.waitForInput(existingName ?? '');
  }

  // ─── Step 2: LSP diagnostics ───────────────────────────────────────────────

  private async stepLsp(): Promise<void> {
    this.step = 2;
    this.renderHeader();

    this.addStepText('\n  ' + C.ok('LSP diagnostics'));
    this.tui.requestRender();

    const statuses = getLspStatuses(process.cwd());

    if (statuses.length === 0) {
      this.clearStep();
      return;
    }

    const lines = statuses.map((s) => {
      const langLabel = C.ok(s.lang.padEnd(14));
      const serverLabel = C.dim((s.lspServer ?? '(no LSP server)').padEnd(34));
      const statusPart =
        s.lspStatus === 'active'
          ? C.ok('✓ installed')
          : s.lspStatus === 'not_installed'
            ? C.err('✗ not installed') + (s.lspInstallCmd ? `  install: ${C.dim(s.lspInstallCmd)}` : '')
            : C.dim('no LSP');
      return `\n  ${langLabel}  ${serverLabel}  ${statusPart}`;
    });

    this.addStepText(
      '\n  Detected languages:' +
        lines.join('') +
        '\n\n  Uninstalled language servers need manual install; see each server docs.',
    );
    this.tui.requestRender();
    this.clearStep();
  }

  // ─── Step 3: Code graph ────────────────────────────────────────────────────

  private async stepGraph(): Promise<void> {
    this.step = 3;
    this.renderHeader();

    this.addStepText('\n  ' + C.ok('Code graph'));

    const dbPath = join(process.cwd(), '.mu-agent', 'graph.db');
    const dbExists = existsSync(dbPath);
    const statusMsg = dbExists
      ? `\n  ${C.ok('✓')} Code graph exists (graph.db)`
      : `\n  ${C.dim('Code graph not built yet')}`;
    this.addStepText(statusMsg + '\n\n  Build now?');
    this.tui.requestRender();

    const choice = await this.waitForSelect([
      { value: 'yes', label: dbExists ? 'Yes, rebuild' : 'Yes, build now' },
      { value: 'no', label: 'No, skip' },
    ]);

    this.clearStep();

    if (choice?.value === 'yes') {
      const loader = new Loader(
        this.tui,
        (s) => C.pending(s),
        (s) => C.dim(s),
        'Building code graph...',
      );
      this.tui.addChild(loader);
      loader.start();
      this.tui.requestRender();

      let buildError: string | null = null;
      try {
        const { CodeGraphLocator } = await import('../core/graph/locator.js');
        const locator = new CodeGraphLocator(process.cwd());
        locator.buildGraph();
      } catch (e) {
        buildError = e instanceof Error ? e.message : String(e);
      }

      loader.stop();
      this.tui.removeChild(loader);

      this.graphBuilt = !buildError;
      const resultText = buildError
        ? `\n  ${C.err(`✗ Build failed: ${buildError}`)}`
        : `\n  ${C.ok('✓ Code graph built')}`;
      this.addStepText(resultText);
      this.tui.requestRender();
    }
  }

  // ─── Step 4: Done ──────────────────────────────────────────────────────────

  private stepDone(): void {
    this.step = 4;
    this.renderHeader();

    const statuses = getLspStatuses(process.cwd());
    const dbPath = join(process.cwd(), '.mu-agent', 'graph.db');

    const notInstalled = statuses.filter((s) => s.lspStatus === 'not_installed');
    const lspLine =
      statuses.length === 0
        ? ''
        : notInstalled.length === 0
          ? `\n  ${C.ok('✓')} LSP ready`
          : notInstalled.map((s) => `\n  ${C.err('✗')} LSP: ${s.lspServer} not installed`).join('');

    const graphOk = this.graphBuilt ?? existsSync(dbPath);
    const graphLine = graphOk ? `\n  ${C.ok('✓')} Code graph built` : `\n  ${C.err('✗')} Code graph not built`;

    const done = new Text(
      `\n  ${C.ok('Setup complete!')}` + lspLine + graphLine + `\n\n  Get started:\n  ${C.dim('mu-agent tui')}`,
      0,
      0,
    );
    this.tui.addChild(done);
    this.tui.requestRender();
  }

  // ─── Step lifecycle ───────────────────────────────────────────────────────

  private addStepText(text: string): Text {
    const comp = new Text(text, 0, 0);
    this.tui.addChild(comp);
    this.stepComponents.push(comp);
    return comp;
  }

  private clearStep(): void {
    for (const comp of this.stepComponents) {
      this.tui.removeChild(comp);
    }
    this.stepComponents = [];
    this.tui.requestRender();
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private waitForSelect(items: SelectItem[], defaultIndex = 0): Promise<SelectItem | null> {
    return new Promise((resolve) => {
      const list = new SelectList(items, 6, selectTheme);
      list.setSelectedIndex(defaultIndex);

      list.onSelect = (item) => {
        this.tui.removeChild(list);
        this.tui.setFocus(null);
        this.tui.requestRender();
        resolve(item);
      };

      list.onCancel = () => {
        this.tui.removeChild(list);
        this.tui.setFocus(null);
        this.tui.requestRender();
        resolve(null);
      };

      this.tui.addChild(list);
      this.tui.setFocus(list);
      this.tui.requestRender();
    });
  }

  private waitForInput(defaultValue: string): Promise<string> {
    return new Promise((resolve) => {
      const input = new Input();
      input.setValue(defaultValue);

      input.onSubmit = (value) => {
        this.tui.removeChild(input);
        this.tui.setFocus(null);
        this.tui.requestRender();
        resolve(value || defaultValue);
      };

      input.onEscape = () => {
        this.tui.removeChild(input);
        this.tui.setFocus(null);
        this.tui.requestRender();
        resolve(defaultValue);
      };

      this.tui.addChild(input);
      this.tui.setFocus(input);
      this.tui.requestRender();
    });
  }
}

export function createSetupWizard(): SetupWizard {
  return new SetupWizard();
}
