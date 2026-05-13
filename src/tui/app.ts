import {
  Editor,
  Loader,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TUI,
  truncateToWidth,
  visibleWidth,
} from '@mariozechner/pi-tui';
import type { Component, EditorTheme, MarkdownTheme } from '@mariozechner/pi-tui';
import { Markdown } from '@mariozechner/pi-tui';

const R = '\x1b[0m';
function fg(r: number, g: number, b: number) { return (s: string) => `\x1b[38;2;${r};${g};${b}m${s}${R}`; }
function bg(r: number, g: number, b: number) { return (s: string) => `\x1b[48;2;${r};${g};${b}m${s}${R}`; }
function bold(s: string) { return `\x1b[1m${s}\x1b[22m`; }
function dim(s: string)  { return `\x1b[2m${s}\x1b[22m`; }
function italic(s: string) { return `\x1b[3m${s}\x1b[23m`; }
function fgBg(fr: number, fg_g: number, fb: number, br: number, bg_g: number, bb: number) {
  return (s: string) => `\x1b[38;2;${fr};${fg_g};${fb}m\x1b[48;2;${br};${bg_g};${bb}m${s}${R}`;
}
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { ConfigManager } from '../config/manager.js';
import { TaskScheduler } from '../core/agent.js';
import type { ExecutionEvent } from '../core/agent.js';
import { MetricsCollector } from '../core/metrics.js';

export interface TuiAppOptions {
  model: string;
  provider: string;
  baseUrl: string;
}

const C = {
  userBg:      bg(22, 27, 34),
  userBar:     fg(56, 139, 253),
  userText:    fg(230, 237, 243),
  llmBg:       bg(22, 27, 34),
  dim:         fg(110, 118, 129),
  dimItalic:   (s: string) => italic(fg(110, 118, 129)(s)),
  divider:     fg(48, 54, 61),
  toolName:    fg(110, 118, 129),
  toolArg:     fg(88, 166, 255),
  ok:          fg(63, 185, 80),
  err:         fg(248, 81, 73),
  pending:     fg(110, 118, 129),
  stateAnalyze:(s: string) => bold(fg(56, 139, 253)(s)),
  stateLocate: (s: string) => bold(fg(57, 211, 83)(s)),
  stateModify: (s: string) => bold(fg(210, 153, 34)(s)),
  stateVerify: (s: string) => bold(fg(63, 185, 80)(s)),
  stateDone:   (s: string) => bold(fg(63, 185, 80)(s)),
  stateIdle:   fg(110, 118, 129),
  headerCwd:   fg(110, 118, 129),
  headerBranch:fg(63, 185, 80),
  headerModel: fg(88, 166, 255),
  headerSep:   fg(48, 54, 61),
  successText: fg(63, 185, 80),
  hintKey:     fg(139, 148, 158),
};

const STATE_FN: Record<string, (s: string) => string> = {
  ANALYZE: C.stateAnalyze,
  LOCATE:  C.stateLocate,
  MODIFY:  C.stateModify,
  VERIFY:  C.stateVerify,
  DONE:    C.stateDone,
  IDLE:    C.stateIdle,
};

function stateColor(s: string): (t: string) => string {
  return STATE_FN[s] ?? C.dim;
}

const markdownTheme: MarkdownTheme = {
  heading:        (s) => bold(fg(230, 237, 243)(s)),
  link:           fg(88, 166, 255),
  linkUrl:        C.dim,
  code:           fg(227, 179, 65),
  codeBlock:      fg(201, 209, 217),
  codeBlockBorder:C.dim,
  quote:          C.dimItalic,
  quoteBorder:    C.dim,
  hr:             C.dim,
  listBullet:     C.dim,
  bold:           (s) => bold(s),
  italic:         (s) => italic(s),
  strikethrough:  (s) => `\x1b[9m${s}\x1b[29m`,
  underline:      (s) => `\x1b[4m${s}\x1b[24m`,
};

const editorTheme: EditorTheme = {
  borderColor: (s) => `\x1b[97m${s}\x1b[0m`,
  selectList: {
    selectedPrefix: fg(88, 166, 255),
    selectedText:   (s) => bold(s),
    description:    C.dim,
    scrollInfo:     C.dim,
    noMatch:        C.dim,
  },
};

// ─── Helper: fill line with bg color to full width ───────────────────────────

function fillLine(content: string, width: number, bgFn: (s: string) => string): string {
  const vw = visibleWidth(content);
  const pad = Math.max(0, width - vw);
  return bgFn(content + ' '.repeat(pad));
}

// ─── Components ───────────────────────────────────────────────────────────────

class HintLine implements Component {
  invalidate(): void {}
  render(_width: number): string[] {
    return [
      '  ' +
      C.hintKey('Ctrl+C') + C.dim(' 退出') + '   ' +
      C.hintKey('Ctrl+L') + C.dim(' 清屏') + '   ' +
      C.hintKey('Tab') + C.dim(' 展开/折叠思考'),
    ];
  }
}

class HeaderLine implements Component {
  private cwd: string;
  private branch: string;
  private model: string;
  private state = 'IDLE';
  private taskLabel = '';
  private contextPct = 0;

  constructor(model: string) {
    this.model = model;
    const home = homedir();
    const cwd = process.cwd();
    this.cwd = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
    try {
      this.branch = execSync('git branch --show-current', {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch { this.branch = ''; }
  }

  setState(state: string, taskIndex = 0, taskTotal = 0, contextPct = 0): void {
    this.state = state;
    this.taskLabel = taskTotal > 0 ? ` [${taskIndex}/${taskTotal}]` : '';
    this.contextPct = contextPct;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const leftParts = [
      C.headerCwd(this.cwd),
      ...(this.branch ? [C.headerBranch(this.branch)] : []),
      C.headerModel(this.model),
    ];
    const left = leftParts.join(C.headerSep('  │  '));
    const colorFn = stateColor(this.state);
    const right = colorFn(this.state + this.taskLabel) + '  ' + C.dim('ctx ' + this.contextPct + '%');
    const leftW = visibleWidth(left);
    const rightW = visibleWidth(right);
    const gap = Math.max(1, width - leftW - rightW - 2);
    return [' ' + left + ' '.repeat(gap) + right + ' '];
  }
}

// ─── UserMessage ──────────────────────────────────────────────────────────────

class UserMessage implements Component {
  private text: string;
  constructor(text: string) { this.text = text; }
  invalidate(): void {}
  render(width: number): string[] {
    const bar = C.userBar('▌');
    const content = bar + ' ' + C.userText(this.text);
    return [
      '',
      fillLine('  ' + content, width, C.userBg),
      '',
    ];
  }
}

// ─── ThinkingBlock ────────────────────────────────────────────────────────────

class ThinkingBlock implements Component {
  private content: string;
  expanded = false;
  constructor(content: string) { this.content = content; }
  toggle(): void { this.expanded = !this.expanded; }
  invalidate(): void {}
  render(width: number): string[] {
    const arrow = this.expanded ? '▾' : '▸';
    const header = '  ' + C.dimItalic(arrow + ' 思考过程');
    const lines: string[] = [header];
    if (this.expanded) {
      for (const line of this.content.split('\n')) {
        lines.push('    ' + C.dimItalic(truncateToWidth(line, width - 6)));
      }
      lines.push('');
    }
    return lines;
  }
}

// ─── LlmOutput ───────────────────────────────────────────────────────────────

class LlmOutput implements Component {
  private inner: Markdown;
  constructor(content: string) {
    this.inner = new Markdown(content, 0, 0, markdownTheme);
  }
  invalidate(): void { this.inner.invalidate(); }
  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    const childLines = this.inner.render(innerWidth);
    const result: string[] = [];
    for (const line of childLines) {
      result.push(fillLine('  ' + line, width, C.llmBg));
    }
    if (result.length > 0) {
      result.push('');
    }
    return result;
  }
}

// ─── ToolLine ─────────────────────────────────────────────────────────────────

class ToolLine implements Component {
  private tool: string;
  private argStr: string;
  status: 'pending' | 'ok' | 'error' = 'pending';

  constructor(tool: string, args?: Record<string, unknown>) {
    this.tool = tool;
    this.argStr = ToolLine.fmtArgs(args);
  }

  private static fmtArgs(args?: Record<string, unknown>): string {
    if (!args) return '';
    for (const key of ['filePath', 'path', 'file', 'command', 'cmd', 'query']) {
      const v = args[key];
      if (typeof v === 'string') return v.slice(0, 50);
    }
    const first = Object.values(args).find((v) => typeof v === 'string');
    return typeof first === 'string' ? first.slice(0, 50) : '';
  }

  setResult(isError: boolean): void { this.status = isError ? 'error' : 'ok'; }
  invalidate(): void {}

  render(width: number): string[] {
    const bullet = C.dim('  › ');
    const name = C.toolName((this.tool + '    ').slice(0, 16));
    const arg = this.argStr ? C.toolArg(this.argStr) : '';
    const mark = this.status === 'ok' ? C.ok('✓') : this.status === 'error' ? C.err('✗') : C.pending('…');
    const left = bullet + name + arg;
    const gap = Math.max(2, width - visibleWidth(left) - 2);
    return [left + ' '.repeat(gap) + mark];
  }
}

// ─── AssistantTurn ────────────────────────────────────────────────────────────

class AssistantTurn implements Component {
  private state: string;
  thinkingBlock: ThinkingBlock | null = null;
  private outputComp: LlmOutput | null = null;
  private toolLines: ToolLine[] = [];
  private toolMap = new Map<string, ToolLine>();

  constructor(state: string) { this.state = state; }

  setThinking(content: string): void { this.thinkingBlock = new ThinkingBlock(content); }
  setOutput(content: string): void { this.outputComp = new LlmOutput(content); }

  addTool(id: string, tool: string, args?: Record<string, unknown>): void {
    const line = new ToolLine(tool, args);
    this.toolLines.push(line);
    this.toolMap.set(id, line);
  }

  resolveTool(id: string, isError: boolean): void {
    this.toolMap.get(id)?.setResult(isError);
  }

  invalidate(): void {
    this.thinkingBlock?.invalidate();
    this.outputComp?.invalidate();
    for (const t of this.toolLines) t.invalidate();
  }

  render(width: number): string[] {
    const colorFn = stateColor(this.state);
    const lines: string[] = ['', '  ' + colorFn(this.state)];
    if (this.thinkingBlock) lines.push(...this.thinkingBlock.render(width));
    if (this.outputComp) lines.push(...this.outputComp.render(width));
    for (const tl of this.toolLines) lines.push(...tl.render(width));
    return lines;
  }
}

// ─── TuiApp ───────────────────────────────────────────────────────────────────

export class TuiApp {
  private tui: TUI;
  private editor: Editor;
  private header: HeaderLine;
  private metrics = new MetricsCollector();
  private running = false;
  private lastThinkingBlock: ThinkingBlock | null = null;

  constructor(private options: TuiAppOptions) {
    const terminal = new ProcessTerminal();
    this.tui = new TUI(terminal);
    this.header = new HeaderLine(options.model);

    this.tui.addChild(this.header);
    this.tui.addChild(new Spacer(1));

    this.editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
    this.editor.onSubmit = (value) => this.handleSubmit(value);

    this.tui.addInputListener((data) => {
      if (data === '\x03' || matchesKey(data, 'ctrl+c')) { this.stop(); return { consume: true }; }
      if (data === '\x0c' || matchesKey(data, 'ctrl+l')) { this.clearMessages(); return { consume: true }; }
      if (data === '\t') {
        if (this.lastThinkingBlock) {
          this.lastThinkingBlock.toggle();
          this.tui.requestRender(true);
        }
        return { consume: true };
      }
      return undefined;
    });

    this.tui.addChild(this.editor);
    this.tui.addChild(new HintLine());
  }

  start(): void {
    this.running = true;
    ConfigManager.getInstance().initialize();
    process.on('SIGINT', () => this.stop());
    this.tui.setFocus(this.editor);
    this.tui.start();
    this.insertBefore(new Text('\x1b[37m  准备就绪，输入任务后按 Enter 执行\x1b[0m', 0, 0));
    this.tui.requestRender();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.tui.stop();
    process.exit(0);
  }

  private clearMessages(): void {
    const editorIdx = this.tui.children.indexOf(this.editor);
    this.tui.children.splice(3, editorIdx - 3);
    this.lastThinkingBlock = null;
    this.tui.requestRender(true);
  }

  private insertBefore(component: Component): void {
    const idx = this.tui.children.indexOf(this.editor);
    this.tui.children.splice(idx, 0, component);
  }

  private async handleSubmit(value: string): Promise<void> {
    const task = value.trim();
    if (!task) return;

    this.editor.disableSubmit = true;
    this.editor.addToHistory(task);

    this.insertBefore(new UserMessage(task));

    const scheduler = new TaskScheduler();
    const tasks = await scheduler.decompose(task);
    if (tasks.length > 1) {
      this.insertBefore(new Text(C.dim(`  分解为 ${tasks.length} 个子任务`), 0, 0));
    }
    this.tui.requestRender();

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]!;
      this.header.setState('ANALYZE', i + 1, tasks.length);

      let currentTurn: AssistantTurn | null = null;
      const pendingTools = new Map<string, string>();

      const loader = new Loader(
        this.tui,
        (s) => stateColor('ANALYZE')(s),
        (s) => C.dim(s),
        '执行中...',
      );
      this.insertBefore(loader);
      loader.start();
      this.tui.requestRender();

      this.metrics.startTask(t.id);
      this.metrics.recordStateEntry(t.id, 'ANALYZE');

      const onEvent = (event: ExecutionEvent): void => {
        if (event.type === 'state_change') {
          this.header.setState(event.to, i + 1, tasks.length);
          loader.setMessage(`[${event.to}]`);
          this.metrics.recordStateExit(t.id, event.from);
          this.metrics.recordStateEntry(t.id, event.to);
          currentTurn = new AssistantTurn(event.to);
          const idx = this.tui.children.indexOf(loader);
          this.tui.children.splice(idx, 0, currentTurn);

        } else if (event.type === 'llm_thinking') {
          if (!currentTurn) {
            currentTurn = new AssistantTurn('ANALYZE');
            const idx = this.tui.children.indexOf(loader);
            this.tui.children.splice(idx, 0, currentTurn);
          }
          currentTurn.setThinking(event.content);
          if (currentTurn.thinkingBlock) this.lastThinkingBlock = currentTurn.thinkingBlock;

        } else if (event.type === 'llm_output') {
          if (!currentTurn) {
            currentTurn = new AssistantTurn('ANALYZE');
            const idx = this.tui.children.indexOf(loader);
            this.tui.children.splice(idx, 0, currentTurn);
          }
          currentTurn.setOutput(event.content);

        } else if (event.type === 'tool_call') {
          if (!currentTurn) {
            currentTurn = new AssistantTurn('ANALYZE');
            const idx = this.tui.children.indexOf(loader);
            this.tui.children.splice(idx, 0, currentTurn);
          }
          const toolId = `${Date.now()}-${event.tool}`;
          pendingTools.set(toolId, event.tool);
          currentTurn.addTool(toolId, event.tool, event.args);
          loader.setMessage(`[${event.tool}]`);
          this.metrics.recordToolCall(t.id, event.tool);

        } else if (event.type === 'tool_result') {
          const entry = [...pendingTools.entries()].reverse().find(([, v]) => v === event.tool);
          if (entry && currentTurn) {
            currentTurn.resolveTool(entry[0], event.isError);
            pendingTools.delete(entry[0]);
          }

        } else if (event.type === 'llm_call') {
          this.metrics.recordLLMCall(t.id, event.promptLen, event.responseLen);
        }

        this.tui.requestRender();
      };

      try {
        const result = await scheduler.executeTask(
          t, this.options.model, this.options.provider, this.options.baseUrl, onEvent,
        );
        loader.stop();
        this.tui.removeChild(loader);
        this.metrics.recordStateExit(t.id, result.state);
        this.metrics.finishTask(t.id, result.success);
        this.insertBefore(new Text(
          result.success ? C.successText('  ✓  子任务完成') : C.err('  ✗  子任务失败'),
          0, 0,
        ));
      } catch (err) {
        loader.stop();
        this.tui.removeChild(loader);
        this.metrics.finishTask(t.id, false);
        this.insertBefore(new Text(C.err(`  ✗  错误: ${String(err)}`), 0, 0));
      }

      this.tui.requestRender();
    }

    const summary = this.metrics.getSummary();
    const tokens = Math.round(summary.avgTokens * tasks.length);
    const rate = Math.round(summary.successRate * 100);
    this.insertBefore(new Text(
      '\n' + C.successText('  ✓  全部完成') + C.dim(`  成功率 ${rate}%  tokens≈${tokens}`),
      0, 0,
    ));
    this.header.setState('IDLE');
    this.editor.disableSubmit = false;
    this.tui.requestRender();
  }
}

export function createTuiApp(options: TuiAppOptions): TuiApp {
  return new TuiApp(options);
}
