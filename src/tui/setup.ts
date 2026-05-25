import { Input, Loader, ProcessTerminal, SelectList, Text, TUI } from '@mariozechner/pi-tui';
import type { SelectItem } from '@mariozechner/pi-tui';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, saveConfig } from '../config/index.js';
import { getLspStatus } from '../config/lsp-status.js';
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

  constructor() {
    const terminal = new ProcessTerminal();
    this.tui = new TUI(terminal);
  }

  async run(): Promise<void> {
    this.tui.start();
    this.renderHeader();

    await this.stepModel();
    await this.stepLsp();
    await this.stepGraph();
    this.stepDone();

    await new Promise<void>((resolve) => {
      const removeListener = this.tui.addInputListener(() => {
        removeListener();
        resolve();
        return { consume: true };
      });
    });

    this.tui.stop();
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

  private async stepModel(): Promise<void> {
    this.step = 1;
    this.renderHeader();

    const cfg = loadConfig();

    const title = new Text('\n  ' + C.ok('模型配置'), 0, 0);
    this.tui.addChild(title);

    const providerLabel = new Text('\n  Provider', 0, 0);
    this.tui.addChild(providerLabel);

    let provider: string = cfg.model.provider;
    const providerItems: SelectItem[] = [
      { value: 'ollama', label: 'ollama', description: 'Local Ollama server' },
      { value: 'openai', label: 'openai', description: 'OpenAI-compatible API' },
      { value: 'custom', label: 'custom', description: 'Custom base URL' },
    ];
    const defaultProviderIdx = providerItems.findIndex((i) => i.value === provider);

    const selectedProvider = await this.waitForSelect(providerItems, defaultProviderIdx < 0 ? 0 : defaultProviderIdx);
    if (selectedProvider) {
      provider = selectedProvider.value;
    }

    this.tui.removeChild(providerLabel);

    const modelNameLabel = new Text(`\n  Provider: ${C.ok(provider)}\n  模型名称:`, 0, 0);
    this.tui.addChild(modelNameLabel);
    const modelName = await this.waitForInput(cfg.model.name);
    this.tui.removeChild(modelNameLabel);

    const baseUrlDefault =
      provider === 'ollama'
        ? 'http://localhost:11434'
        : provider === 'openai'
          ? 'https://api.openai.com/v1'
          : cfg.model.baseUrl;
    const baseUrlLabel = new Text(`\n  Provider: ${C.ok(provider)}\n  模型名称: ${C.ok(modelName)}\n  Base URL:`, 0, 0);
    this.tui.addChild(baseUrlLabel);
    const baseUrl = await this.waitForInput(cfg.model.baseUrl || baseUrlDefault);
    this.tui.removeChild(baseUrlLabel);

    const ctxLabel = new Text(
      `\n  Provider: ${C.ok(provider)}\n  模型名称: ${C.ok(modelName)}\n  Base URL: ${C.ok(baseUrl)}\n  Context Length:`,
      0,
      0,
    );
    this.tui.addChild(ctxLabel);
    const ctxRaw = await this.waitForInput(String(cfg.model.contextLength || 32768));
    this.tui.removeChild(ctxLabel);

    const contextLength = parseInt(ctxRaw, 10) || cfg.model.contextLength;

    saveConfig({
      model: {
        provider: provider as 'ollama' | 'openai' | 'custom',
        name: modelName,
        baseUrl,
        contextLength,
      },
    });

    const summary = new Text(`\n  ${C.ok('✓')} 模型配置已保存: ${C.ok(modelName)} (${provider})`, 0, 0);
    this.tui.addChild(summary);
    this.tui.removeChild(title);
    this.tui.requestRender();
  }

  // ─── Step 2: LSP 诊断 ─────────────────────────────────────────────────────

  private async stepLsp(): Promise<void> {
    this.step = 2;
    this.renderHeader();

    const title = new Text('\n  ' + C.ok('LSP 诊断'), 0, 0);
    this.tui.addChild(title);
    this.tui.requestRender();

    const lspStatus = getLspStatus(process.cwd());

    if (lspStatus.status === 'not_detected') {
      const msg = new Text(`\n  ${C.dim('未检测到支持的项目语言，跳过 LSP 配置')}`, 0, 0);
      this.tui.addChild(msg);
      this.tui.requestRender();
      await this.shortPause();
      this.tui.removeChild(title);
      return;
    }

    const langLabel = lspStatus.detectedLanguage ?? '';
    const serverLabel = lspStatus.server ?? '';
    const statusMark = lspStatus.status === 'active' ? C.ok('✓ 已安装') : C.err(`✗ 未安装`);

    const infoText = new Text(`\n  检测到 ${C.ok(langLabel)} 项目\n\n  ${serverLabel}   ${statusMark}`, 0, 0);
    this.tui.addChild(infoText);
    this.tui.requestRender();

    if (lspStatus.status === 'active') {
      await this.shortPause();
      this.tui.removeChild(title);
      this.tui.removeChild(infoText);
      return;
    }

    // Not installed — ask to install
    const installLabel = new Text(
      `\n  安装命令: ${C.dim(lspStatus.installCommand ?? '')}` + `\n\n  是否现在安装？`,
      0,
      0,
    );
    this.tui.addChild(installLabel);

    const choice = await this.waitForSelect([
      { value: 'yes', label: '是，立即安装' },
      { value: 'no', label: '否，跳过' },
    ]);

    this.tui.removeChild(installLabel);
    this.tui.removeChild(infoText);

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

      const resultMsg = installError
        ? new Text(`\n  ${C.err(`✗ 安装失败: ${installError}`)}`, 0, 0)
        : new Text(`\n  ${C.ok(`✓ ${serverLabel} 已安装`)}`, 0, 0);
      this.tui.addChild(resultMsg);
      this.tui.requestRender();
      await this.shortPause();
      this.tui.removeChild(resultMsg);
    }

    this.tui.removeChild(title);
    this.tui.requestRender();
  }

  // ─── Step 3: 代码图 ───────────────────────────────────────────────────────

  private async stepGraph(): Promise<void> {
    this.step = 3;
    this.renderHeader();

    const title = new Text('\n  ' + C.ok('代码图'), 0, 0);
    this.tui.addChild(title);

    const dbPath = join(process.cwd(), '.local-agent', 'graph.db');
    const dbExists = existsSync(dbPath);

    const statusMsg = dbExists ? `\n  ${C.ok('✓')} 代码图已存在 (graph.db)` : `\n  ${C.dim('代码图尚未构建')}`;

    const statusText = new Text(statusMsg + '\n\n  是否现在构建？', 0, 0);
    this.tui.addChild(statusText);
    this.tui.requestRender();

    const choice = await this.waitForSelect([
      { value: 'yes', label: dbExists ? '是，重新构建' : '是，立即构建' },
      { value: 'no', label: '否，跳过' },
    ]);

    this.tui.removeChild(statusText);

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

      const resultMsg = buildError
        ? new Text(`\n  ${C.err(`✗ 构建失败: ${buildError}`)}`, 0, 0)
        : new Text(`\n  ${C.ok('✓ 代码图已构建')}`, 0, 0);
      this.tui.addChild(resultMsg);
      this.tui.requestRender();
      await this.shortPause();
      this.tui.removeChild(resultMsg);
    }

    this.tui.removeChild(title);
    this.tui.requestRender();
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

    const graphLine = existsSync(dbPath) ? `\n  ${C.ok('✓')} 代码图已构建` : `\n  ${C.err('✗')} 代码图未构建`;

    const done = new Text(
      `\n  ${C.ok('设置完成！')}` +
        lspLine +
        graphLine +
        `\n\n  开始使用:\n  ${C.dim('npx tsx src/cli.ts tui')}\n\n  按任意键退出`,
      0,
      0,
    );
    this.tui.addChild(done);
    this.tui.requestRender();
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private waitForSelect(items: SelectItem[], defaultIndex = 0): Promise<SelectItem | null> {
    return new Promise((resolve) => {
      const list = new SelectList(items, 6, selectTheme);
      list.setSelectedIndex(defaultIndex);

      list.onSelect = (item) => {
        this.tui.removeChild(list);
        this.tui.requestRender();
        resolve(item);
      };

      list.onCancel = () => {
        this.tui.removeChild(list);
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
        this.tui.requestRender();
        resolve(value || defaultValue);
      };

      input.onEscape = () => {
        this.tui.removeChild(input);
        this.tui.requestRender();
        resolve(defaultValue);
      };

      this.tui.addChild(input);
      this.tui.setFocus(input);
      this.tui.requestRender();
    });
  }

  private shortPause(ms = 800): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function createSetupWizard(): SetupWizard {
  return new SetupWizard();
}
