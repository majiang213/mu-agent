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
import type { Component } from '@mariozechner/pi-tui';
import { Markdown } from '@mariozechner/pi-tui';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { ConfigManager } from '../config/manager.js';
import { ReactAgent } from '../core/agent.js';
import type { ExecutionEvent } from '../core/agent.js';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { MetricsCollector } from '../core/metrics.js';
import { C, stateColor, fillLine, markdownTheme, editorTheme } from './theme.js';

export interface TuiAppOptions {
  model: string;
  provider: string;
  baseUrl: string;
}
// ─── Components ───────────────────────────────────────────────────────────────

class HintLine implements Component {
  private debugMode = false;
  setDebugMode(v: boolean): void {
    this.debugMode = v;
  }
  invalidate(): void {}
  render(_width: number): string[] {
    const debugLabel = this.debugMode ? C.ok(' [调试开]') : C.dim(' 调试');
    return [
      '  ' +
        C.hintKey('Ctrl+C') +
        C.dim(' 退出') +
        '   ' +
        C.hintKey('Tab') +
        C.dim(' 展开/折叠思考') +
        '   ' +
        C.hintKey('d') +
        debugLabel,
    ];
  }
}

class HeaderLine implements Component {
  private cwd: string;
  private branch: string;
  private model: string;
  private state = 'IDLE';
  private taskLabel = '';
  private contextTokensK = 0;

  constructor(model: string) {
    this.model = model;
    const home = homedir();
    const cwd = process.cwd();
    this.cwd = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
    try {
      this.branch = execSync('git branch --show-current', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      this.branch = '';
    }
  }

  setState(state: string, taskIndex = 0, taskTotal = 0): void {
    this.state = state;
    this.taskLabel = taskTotal > 0 ? ` [${taskIndex}/${taskTotal}]` : '';
  }

  setContextTokens(tokens: number): void {
    this.contextTokensK = Math.round((tokens / 1000) * 10) / 10;
  }

  getState(): string {
    return this.state;
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
    const right = colorFn(this.state + this.taskLabel) + '  ' + C.dim('ctx ' + this.contextTokensK + 'k');
    const leftW = visibleWidth(left);
    const rightW = visibleWidth(right);
    const gap = Math.max(1, width - leftW - rightW - 2);
    return [' ' + left + ' '.repeat(gap) + right + ' '];
  }
}

// ─── UserMessage ──────────────────────────────────────────────────────────────

class UserMessage implements Component {
  private text: string;
  constructor(text: string) {
    this.text = text;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const bar = C.userBar('▌');
    const content = bar + ' ' + C.userText(this.text);
    return ['', fillLine('  ' + content, width, visibleWidth), ''];
  }
}

// ─── ThinkingBlock ────────────────────────────────────────────────────────────

class ThinkingBlock implements Component {
  private content: string;
  expanded = false;
  private streaming = false;

  constructor(content: string, streaming = false) {
    this.content = content;
    this.streaming = streaming;
    this.expanded = streaming;
  }

  setContent(content: string): void {
    this.content = content;
  }

  finalize(): void {
    this.streaming = false;
    this.expanded = false;
  }

  toggle(): void {
    this.expanded = !this.expanded;
  }
  setExpanded(v: boolean): void {
    this.expanded = v;
  }
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

// ─── DebugBlock ───────────────────────────────────────────────────────────────

class DebugBlock implements Component {
  private systemPrompt: string;
  private userPrompt: string;
  expanded = false;

  constructor(systemPrompt: string, userPrompt: string) {
    this.systemPrompt = systemPrompt;
    this.userPrompt = userPrompt;
  }

  toggle(): void {
    this.expanded = !this.expanded;
  }

  setExpanded(v: boolean): void {
    this.expanded = v;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const arrow = this.expanded ? '▾' : '▸';
    const header = '  ' + C.dimItalic(arrow + ' 调试: 原始输入');
    if (!this.expanded) return [header];

    const lines: string[] = [header];
    const maxW = width - 6;

    lines.push('    ' + C.dim('── system prompt ──'));
    for (const line of this.systemPrompt.split('\n')) {
      lines.push('    ' + C.dim(truncateToWidth(line, maxW)));
    }
    lines.push('');
    lines.push('    ' + C.dim('── user prompt ──'));
    for (const line of this.userPrompt.split('\n')) {
      lines.push('    ' + C.dim(truncateToWidth(line, maxW)));
    }
    lines.push('');
    return lines;
  }
}

// ─── LlmOutput ───────────────────────────────────────────────────────────────

class LlmOutput implements Component {
  private inner: Markdown;
  constructor(content: string) {
    this.inner = new Markdown(content, 0, 0, markdownTheme);
  }
  setContent(content: string): void {
    this.inner = new Markdown(content, 0, 0, markdownTheme);
    this.inner.invalidate();
  }
  invalidate(): void {
    this.inner.invalidate();
  }
  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    const childLines = this.inner.render(innerWidth);
    const result: string[] = [];
    for (const line of childLines) {
      result.push(fillLine('  ' + line, width, visibleWidth));
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

  setResult(isError: boolean): void {
    this.status = isError ? 'error' : 'ok';
  }
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

  constructor(state: string) {
    this.state = state;
  }

  setThinking(content: string): void {
    this.thinkingBlock = new ThinkingBlock(content);
  }
  setOutput(content: string): void {
    this.outputComp = new LlmOutput(content);
  }

  updateThinking(content: string): void {
    if (!this.thinkingBlock) {
      this.thinkingBlock = new ThinkingBlock(content, true);
    } else {
      this.thinkingBlock.setContent(content);
    }
  }

  updateOutput(content: string): void {
    if (!this.outputComp) {
      this.outputComp = new LlmOutput(content);
    } else {
      this.outputComp.setContent(content);
    }
  }

  finalizeThinking(content: string): void {
    if (this.thinkingBlock) {
      this.thinkingBlock.setContent(content);
      this.thinkingBlock.finalize();
    } else {
      this.thinkingBlock = new ThinkingBlock(content, false);
    }
  }

  finalizeOutput(content: string): void {
    if (this.outputComp) {
      this.outputComp.setContent(content);
    } else {
      this.outputComp = new LlmOutput(content);
    }
  }

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
  private hintLine: HintLine;
  private metrics = new MetricsCollector();
  private running = false;
  private debugMode = false;
  private allThinkingBlocks: ThinkingBlock[] = [];
  private allDebugBlocks: DebugBlock[] = [];
  private conversationHistory: AgentMessage[] = [];

  constructor(private options: TuiAppOptions) {
    const terminal = new ProcessTerminal();
    this.tui = new TUI(terminal);
    this.header = new HeaderLine(options.model);
    this.hintLine = new HintLine();

    this.tui.addChild(this.header);
    this.tui.addChild(new Spacer(1));

    this.editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
    this.editor.onSubmit = (value) => this.handleSubmit(value);

    this.tui.addInputListener((data) => {
      if (data === '\x03' || matchesKey(data, 'ctrl+c')) {
        this.stop();
        return { consume: true };
      }
      if (data === '\t') {
        if (this.allThinkingBlocks.length > 0) {
          const anyExpanded = this.allThinkingBlocks.some((b) => b.expanded);
          for (const b of this.allThinkingBlocks) b.setExpanded(!anyExpanded);
          this.tui.requestRender(true);
        }
        return { consume: true };
      }
      if (data === 'd' || data === 'D') {
        this.debugMode = !this.debugMode;
        this.hintLine.setDebugMode(this.debugMode);
        for (const b of this.allDebugBlocks) b.setExpanded(this.debugMode);
        this.tui.requestRender(true);
        return { consume: true };
      }
      return undefined;
    });

    this.tui.addChild(this.editor);
    this.tui.addChild(this.hintLine);
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

  private insertBefore(component: Component): void {
    const idx = this.tui.children.indexOf(this.editor);
    this.tui.children.splice(idx, 0, component);
  }

  private createEventHandler(
    taskId: string,
    loader: Loader,
    pendingTools: Map<string, string>,
    getCurrentTurn: () => AssistantTurn | null,
    setCurrentTurn: (t: AssistantTurn) => void,
  ): (event: ExecutionEvent) => void {
    const ensureCurrentTurn = (state = 'REASON'): AssistantTurn => {
      let turn = getCurrentTurn();
      if (!turn) {
        turn = new AssistantTurn(state);
        const idx = this.tui.children.indexOf(loader);
        this.tui.children.splice(idx, 0, turn);
        setCurrentTurn(turn);
      }
      return turn;
    };

    return (event: ExecutionEvent): void => {
      if (event.type === 'state_change') {
        this.header.setState(event.to);
        loader.setMessage(`[${event.to}]`);
        this.metrics.recordStateExit(taskId, event.from);
        this.metrics.recordStateEntry(taskId, event.to);
        const turn = new AssistantTurn(event.to);
        const idx = this.tui.children.indexOf(loader);
        this.tui.children.splice(idx, 0, turn);
        setCurrentTurn(turn);
      } else if (event.type === 'llm_thinking_delta') {
        const turn = ensureCurrentTurn();
        turn.updateThinking(event.content);
        if (turn.thinkingBlock && !this.allThinkingBlocks.includes(turn.thinkingBlock)) {
          this.allThinkingBlocks.push(turn.thinkingBlock);
        }
      } else if (event.type === 'llm_output_delta') {
        ensureCurrentTurn().updateOutput(event.content);
      } else if (event.type === 'llm_thinking') {
        const turn = ensureCurrentTurn();
        turn.finalizeThinking(event.content);
        if (turn.thinkingBlock && !this.allThinkingBlocks.includes(turn.thinkingBlock)) {
          this.allThinkingBlocks.push(turn.thinkingBlock);
        }
      } else if (event.type === 'llm_output') {
        ensureCurrentTurn().finalizeOutput(event.content);
      } else if (event.type === 'tool_call') {
        const turn = ensureCurrentTurn();
        const toolId = `${Date.now()}-${event.tool}`;
        pendingTools.set(toolId, event.tool);
        turn.addTool(toolId, event.tool, event.args);
        loader.setMessage(`[${event.tool}]`);
        this.metrics.recordToolCall(taskId, event.tool);
      } else if (event.type === 'tool_result') {
        const entry = [...pendingTools.entries()].reverse().find(([, v]) => v === event.tool);
        const turn = getCurrentTurn();
        if (entry && turn) {
          turn.resolveTool(entry[0], event.isError);
          pendingTools.delete(entry[0]);
        }
      } else if (event.type === 'llm_prompt') {
        const block = new DebugBlock(event.systemPrompt, event.userPrompt);
        block.setExpanded(this.debugMode);
        this.allDebugBlocks.push(block);
        const idx = this.tui.children.indexOf(loader);
        this.tui.children.splice(idx, 0, block);
      } else if (event.type === 'llm_call') {
        this.metrics.recordLLMCall(taskId, event.promptLen, event.responseLen);
        this.header.setContextTokens(event.contextTokens);
      } else if (event.type === 'task_start') {
        this.header.setState(event.description.slice(0, 20), event.taskIndex + 1, event.taskTotal);
      } else if (event.type === 'task_done') {
        this.insertBefore(new Text(C.dim(`  ✓ 子任务 [${event.taskIndex + 1}/${event.taskTotal}] 完成`), 0, 0));
      } else if (event.type === 'clarification_needed') {
        const questions = event.questions.map((q, i) => `  ${i + 1}. ${q}`).join('\n');
        this.insertBefore(new Text(C.dim('  需要确认以下信息：\n') + questions, 0, 0));
        this.editor.disableSubmit = false;
      }

      this.tui.requestRender();
    };
  }

  private async handleSubmit(value: string): Promise<void> {
    const input = value.trim();
    if (!input) return;

    this.editor.disableSubmit = true;
    this.editor.addToHistory(input);
    this.insertBefore(new UserMessage(input));
    this.tui.requestRender();

    const taskId = `task-${Date.now()}`;
    this.header.setState('REASON');

    let currentTurn: AssistantTurn | null = null;
    const pendingTools = new Map<string, string>();

    const loader = new Loader(
      this.tui,
      (s) => stateColor('REASON')(s),
      (s) => C.dim(s),
      '执行中...',
    );
    this.insertBefore(loader);
    loader.start();
    this.tui.requestRender();

    this.metrics.startTask(taskId);
    this.metrics.recordStateEntry(taskId, 'REASON');

    const onEvent = this.createEventHandler(
      taskId,
      loader,
      pendingTools,
      () => currentTurn,
      (t) => {
        currentTurn = t;
      },
    );

    const agent = new ReactAgent();
    try {
      const result = await agent.run(
        input,
        this.options.model,
        this.options.provider,
        this.options.baseUrl,
        onEvent,
        this.conversationHistory,
      );
      loader.stop();
      this.tui.removeChild(loader);
      this.metrics.recordStateExit(taskId, result.state);
      this.metrics.finishTask(taskId, result.success);
      if (result.messages && result.messages.length > 0) {
        this.conversationHistory = result.messages;
      }
    } catch (err) {
      loader.stop();
      this.tui.removeChild(loader);
      this.metrics.finishTask(taskId, false);
      this.insertBefore(new Text(C.err(`  ✗  错误: ${String(err)}`), 0, 0));
    }

    const summary = this.metrics.getSummary();
    const tokens = Math.round(summary.avgTokens);
    const rate = Math.round(summary.successRate * 100);
    this.insertBefore(new Text('\n' + C.successText('  ✓  完成') + C.dim(`  成功率 ${rate}%  tokens≈${tokens}`), 0, 0));
    this.header.setState('IDLE');
    this.editor.disableSubmit = false;
    this.tui.requestRender();
  }
}

export function createTuiApp(options: TuiAppOptions): TuiApp {
  return new TuiApp(options);
}
