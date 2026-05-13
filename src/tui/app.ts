import { Editor, Loader, Markdown, ProcessTerminal, Spacer, Text, TUI, truncateToWidth } from '@mariozechner/pi-tui';
import type { EditorTheme, MarkdownTheme } from '@mariozechner/pi-tui';
import type { Component } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { ConfigManager } from '../config/manager.js';
import { TaskScheduler } from '../core/agent.js';
import { MetricsCollector } from '../core/metrics.js';

export interface TuiAppOptions {
  model: string;
  provider: string;
  baseUrl: string;
}

const editorTheme: EditorTheme = {
  borderColor: (s) => chalk.dim(s),
  selectList: {
    selectedPrefix: (s) => chalk.cyan(s),
    selectedText: (s) => chalk.bold(s),
    description: (s) => chalk.dim(s),
    scrollInfo: (s) => chalk.dim(s),
    noMatch: (s) => chalk.dim(s),
  },
};

const markdownTheme: MarkdownTheme = {
  heading: (s) => chalk.bold.cyan(s),
  link: (s) => chalk.blue(s),
  linkUrl: (s) => chalk.dim(s),
  code: (s) => chalk.yellow(s),
  codeBlock: (s) => chalk.green(s),
  codeBlockBorder: (s) => chalk.dim(s),
  quote: (s) => chalk.italic(s),
  quoteBorder: (s) => chalk.dim(s),
  hr: (s) => chalk.dim(s),
  listBullet: (s) => chalk.cyan(s),
  bold: (s) => chalk.bold(s),
  italic: (s) => chalk.italic(s),
  strikethrough: (s) => chalk.strikethrough(s),
  underline: (s) => chalk.underline(s),
};

function getGitBranch(): string {
  try {
    return execSync('git branch --show-current', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function shortenCwd(cwd: string): string {
  const home = homedir();
  return cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
}

class HeaderLine implements Component {
  private cwd = shortenCwd(process.cwd());
  private branch = getGitBranch();
  private model: string;
  private state = 'IDLE';
  private taskLabel = '';

  constructor(model: string) {
    this.model = model;
  }

  setState(state: string, taskIndex = 0, taskTotal = 0): void {
    this.state = state;
    this.taskLabel = taskTotal > 0 ? ` [${taskIndex}/${taskTotal}]` : '';
  }

  invalidate(): void {}

  render(width: number): string[] {
    const parts: string[] = [
      chalk.dim(this.cwd),
      ...(this.branch ? [chalk.green(this.branch)] : []),
      chalk.cyan(this.model),
      chalk.yellow(this.state + this.taskLabel),
    ];
    const line = ' ' + parts.join(chalk.dim('  │  ')) + ' ';
    return [truncateToWidth(line, width)];
  }
}

class HRule implements Component {
  invalidate(): void {}
  render(width: number): string[] {
    return [chalk.dim('─'.repeat(Math.max(1, width)))];
  }
}

export class TuiApp {
  private tui: TUI;
  private editor: Editor;
  private header: HeaderLine;
  private metrics = new MetricsCollector();
  private running = false;

  constructor(private options: TuiAppOptions) {
    const terminal = new ProcessTerminal();
    this.tui = new TUI(terminal);
    this.header = new HeaderLine(options.model);

    this.tui.addChild(this.header);
    this.tui.addChild(new HRule());
    this.tui.addChild(new Spacer(1));

    this.editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
    this.editor.onSubmit = (value) => this.handleSubmit(value);

    this.tui.addChild(this.editor);
    this.tui.setFocus(this.editor);
  }

  start(): void {
    this.running = true;
    ConfigManager.getInstance().initialize();
    this.tui.start();
    this.addMessage(chalk.dim('准备就绪，输入任务后按 Enter 执行'), 'info');
    this.addMessage(chalk.dim('快捷键: Ctrl+C 退出  Ctrl+L 清屏'), 'info');
    this.tui.requestRender();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.tui.stop();
  }

  private addMessage(text: string, _level: string): void {
    const msg = new Text(text, 1, 0);
    this.tui.children.splice(this.tui.children.length - 1, 0, msg);
    this.tui.requestRender();
  }

  private addSeparator(): void {
    const sep = new HRule();
    this.tui.children.splice(this.tui.children.length - 1, 0, sep);
  }

  private async handleSubmit(value: string): Promise<void> {
    const task = value.trim();
    if (!task) return;

    this.editor.disableSubmit = true;
    this.editor.addToHistory(task);

    this.addSeparator();
    this.addMessage(chalk.bold('▶ ' + task), 'task');

    const scheduler = new TaskScheduler();
    const tasks = await scheduler.decompose(task);

    this.addMessage(chalk.dim(`分解为 ${tasks.length} 个子任务`), 'info');
    this.tui.requestRender();

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]!;

      this.addMessage(chalk.cyan(`[${i + 1}/${tasks.length}] ${t.description}`), 'task');

      const loader = new Loader(
        this.tui,
        (s) => chalk.cyan(s),
        (s) => chalk.dim(s),
        '执行中...',
      );
      this.tui.children.splice(this.tui.children.length - 1, 0, loader);
      loader.start();
      this.tui.requestRender();

      this.metrics.startTask(t.id);
      this.metrics.recordStateEntry(t.id, 'ANALYZE');

      try {
        const result = await scheduler.executeTask(
          t,
          this.options.model,
          this.options.provider,
          this.options.baseUrl,
          (event) => {
            if (event.type === 'state_change') {
              this.header.setState(event.to, i + 1, tasks.length);
              loader.setMessage(`[${event.to}] 执行中...`);
              this.metrics.recordStateExit(t.id, event.from);
              this.metrics.recordStateEntry(t.id, event.to);
            } else if (event.type === 'tool_call') {
              loader.setMessage(`[${event.tool}]`);
              this.metrics.recordToolCall(t.id, event.tool);
            } else if (event.type === 'llm_call') {
              this.metrics.recordLLMCall(t.id, event.promptLen, event.responseLen);
            }
            this.tui.requestRender();
          },
        );

        loader.stop();
        this.tui.removeChild(loader);

        this.metrics.recordStateExit(t.id, result.state);
        this.metrics.finishTask(t.id, result.success);

        if (result.success) {
          this.addMessage(chalk.green(`✓ 子任务 ${i + 1} 完成`), 'success');
        } else {
          this.addMessage(chalk.red(`✗ 子任务 ${i + 1} 失败`), 'error');
        }
      } catch (err) {
        loader.stop();
        this.tui.removeChild(loader);
        this.metrics.finishTask(t.id, false);
        this.addMessage(chalk.red(`✗ 错误: ${String(err)}`), 'error');
      }

      this.tui.requestRender();
    }

    const summary = this.metrics.getSummary();
    const tokens = Math.round(summary.avgTokens * tasks.length);
    this.addMessage(
      chalk.green(`✓ 全部完成`) +
        chalk.dim(`  成功率 ${Math.round(summary.successRate * 100)}%  tokens≈${tokens}`),
      'success',
    );

    this.header.setState('IDLE');
    this.editor.disableSubmit = false;
    this.tui.requestRender();
  }
}

export function createTuiApp(options: TuiAppOptions): TuiApp {
  return new TuiApp(options);
}
