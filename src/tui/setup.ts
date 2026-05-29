import { Input, Loader, ProcessTerminal, SelectList, Text, TUI } from '@mariozechner/pi-tui';
import type { SelectItem } from '@mariozechner/pi-tui';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { saveConfig } from '../config/index.js';
import { getLspStatus } from '../config/lsp-status.js';
import { fetchOllamaModels, fetchCustomModels } from '../provider/model-info.js';
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

    await new Promise<void>((resolve) => process.nextTick(resolve));
    this.tui.stop();
    process.exit(0);
  }

  // ─── Header ────────────────────────────────────────────────────────────────

  private headerComp: Text | null = null;

  private renderHeader(): void {
    if (this.headerComp) {
      this.tui.removeChild(this.headerComp);
    }
    this.headerComp = new Text(
      C.dim(`  local-agent setup`) + '  ' + C.dim(`步骤 ${this.step}/${this.totalSteps}`),
      0,
      0,
    );
    this.tui.addChild(this.headerComp);
    this.tui.requestRender();
  }

  // ─── Step 1: 模型配置 ──────────────────────────────────────────────────────

  private loadExistingModel(): Partial<Config['model']> {
    const paths = [
      join(process.cwd(), '.local-agent', 'config.json'),
      join(homedir(), '.config', 'local-agent', 'config.json'),
    ];
    for (const p of paths) {
      if (existsSync(p)) {
        try {
          const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Partial<Config>;
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

    const existing = this.loadExistingModel();

    this.addStepText('\n  ' + C.ok('模型配置'));
    this.addStepText('\n  Provider');

    let provider: string = existing.provider ?? 'ollama';
    const providerItems: SelectItem[] = [
      { value: 'ollama', label: 'ollama', description: 'Local Ollama server' },
      { value: 'custom', label: 'custom', description: 'Custom base URL' },
    ];
    const defaultProviderIdx = providerItems.findIndex((i) => i.value === provider);
    const selectedProvider = await this.waitForSelect(providerItems, defaultProviderIdx < 0 ? 0 : defaultProviderIdx);
    if (selectedProvider) provider = selectedProvider.value;

    const baseUrlDefault = provider === 'ollama' ? 'http://localhost:11434' : '';
    this.addStepText(`\n  Provider: ${C.ok(provider)}\n  Base URL:`);
    const baseUrl = await this.waitForInput(existing.baseUrl ?? baseUrlDefault);

    const modelName = await this.pickModel(provider, baseUrl, existing.name);

    let modelSize: number | undefined;
    if (provider === 'custom') {
      this.addStepText(
        `\n  模型大小（单位：B，如 7 表示 7B，影响 Heavy Thinking 和约束强度）\n  留空跳过（默认视为大模型）:\n  模型大小:`,
      );
      const raw = await this.waitForInput(existing.modelSize != null ? String(existing.modelSize) : '');
      const parsed = parseFloat(raw.trim());
      if (!isNaN(parsed) && parsed > 0) modelSize = parsed;
    }

    saveConfig({
      model: {
        provider: provider as 'ollama' | 'custom',
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
      '正在获取模型列表...',
    );
    this.tui.addChild(loader);
    loader.start();
    this.tui.requestRender();

    const models = provider === 'ollama' ? await fetchOllamaModels(baseUrl) : await fetchCustomModels(baseUrl);

    loader.stop();
    this.tui.removeChild(loader);

    if (models.length === 0) {
      this.addStepText(`\n  ${C.dim('未能获取模型列表，请手动输入')}\n  模型名称:`);
      return this.waitForInput(existingName ?? '');
    }

    const items: SelectItem[] = models.map((m) => ({
      value: m.name,
      label: m.name,
      description: `context: ${m.contextLength.toLocaleString()}`,
    }));
    this.addStepText('\n  选择模型:');
    this.tui.requestRender();

    const defaultIdx = existingName ? items.findIndex((i) => i.value === existingName) : 0;
    const selected = await this.waitForSelect(items, defaultIdx < 0 ? 0 : defaultIdx);

    if (selected) return selected.value;

    this.addStepText(`\n  模型名称:`);
    return this.waitForInput(existingName ?? '');
  }

  // ─── Step 2: LSP 诊断 ─────────────────────────────────────────────────────

  private async stepLsp(): Promise<void> {
    this.step = 2;
    this.renderHeader();

    this.addStepText('\n  ' + C.ok('LSP 诊断'));
    this.tui.requestRender();

    const lspStatus = getLspStatus(process.cwd());

    if (lspStatus.status === 'not_detected') {
      this.clearStep();
      return;
    }

    const langLabel = lspStatus.detectedLanguage ?? '';
    const serverLabel = lspStatus.server ?? '';
    const statusMark = lspStatus.status === 'active' ? C.ok('✓ 已安装') : C.err('✗ 未安装');

    this.addStepText(`\n  检测到 ${C.ok(langLabel)} 项目\n\n  ${serverLabel}   ${statusMark}`);
    this.tui.requestRender();

    if (lspStatus.status === 'active') {
      this.clearStep();
      return;
    }

    this.addStepText(`\n  安装命令: ${C.dim(lspStatus.installCommand ?? '')}\n\n  是否现在安装？`);

    const choice = await this.waitForSelect([
      { value: 'yes', label: '是，立即安装' },
      { value: 'no', label: '否，跳过' },
    ]);

    this.clearStep();

    if (choice?.value === 'yes' && lspStatus.installCommand) {
      const loader = new Loader(
        this.tui,
        (s) => C.pending(s),
        (s) => C.dim(s),
        `正在安装 ${serverLabel}...`,
      );
      this.tui.addChild(loader);
      loader.start();
      this.tui.requestRender();

      let installError: string | null = null;
      try {
        execSync(lspStatus.installCommand, { stdio: 'ignore' });
      } catch (e) {
        installError = e instanceof Error ? e.message : String(e);
      }

      loader.stop();
      this.tui.removeChild(loader);

      const resultText = installError
        ? `\n  ${C.err(`✗ 安装失败: ${installError}`)}`
        : `\n  ${C.ok(`✓ ${serverLabel} 已安装`)}`;
      this.addStepText(resultText);
      this.tui.requestRender();
    }
  }

  // ─── Step 3: 代码图 ───────────────────────────────────────────────────────

  private async stepGraph(): Promise<void> {
    this.step = 3;
    this.renderHeader();

    this.addStepText('\n  ' + C.ok('代码图'));

    const dbPath = join(process.cwd(), '.local-agent', 'graph.db');
    const dbExists = existsSync(dbPath);
    const statusMsg = dbExists ? `\n  ${C.ok('✓')} 代码图已存在 (graph.db)` : `\n  ${C.dim('代码图尚未构建')}`;
    this.addStepText(statusMsg + '\n\n  是否现在构建？');
    this.tui.requestRender();

    const choice = await this.waitForSelect([
      { value: 'yes', label: dbExists ? '是，重新构建' : '是，立即构建' },
      { value: 'no', label: '否，跳过' },
    ]);

    this.clearStep();

    if (choice?.value === 'yes') {
      const loader = new Loader(
        this.tui,
        (s) => C.pending(s),
        (s) => C.dim(s),
        '正在构建代码图...',
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
      const resultText = buildError ? `\n  ${C.err(`✗ 构建失败: ${buildError}`)}` : `\n  ${C.ok('✓ 代码图已构建')}`;
      this.addStepText(resultText);
      this.tui.requestRender();
    }
  }

  // ─── Step 4: 完成 ─────────────────────────────────────────────────────────

  private stepDone(): void {
    this.step = 4;
    this.renderHeader();

    const lspStatus = getLspStatus(process.cwd());
    const dbPath = join(process.cwd(), '.local-agent', 'graph.db');

    const lspLine =
      lspStatus.status === 'active'
        ? `\n  ${C.ok('✓')} ${lspStatus.server ?? 'LSP'} 已安装`
        : lspStatus.status === 'not_installed'
          ? `\n  ${C.err('✗')} LSP: ${lspStatus.server} 未安装`
          : '';

    const graphOk = this.graphBuilt ?? existsSync(dbPath);
    const graphLine = graphOk ? `\n  ${C.ok('✓')} 代码图已构建` : `\n  ${C.err('✗')} 代码图未构建`;

    const done = new Text(
      `\n  ${C.ok('设置完成！')}` + lspLine + graphLine + `\n\n  开始使用:\n  ${C.dim('npx tsx src/cli.ts tui')}`,
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
