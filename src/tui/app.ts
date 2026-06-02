import {
  Editor,
  Loader,
  matchesKey,
  ProcessTerminal,
  Text,
  TUI,
  truncateToWidth,
  visibleWidth,
} from '@mariozechner/pi-tui';
import type { Component } from '@mariozechner/pi-tui';
import { Markdown } from '@mariozechner/pi-tui';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

import { ReactAgent } from '../core/agent/index.js';
import type { ExecutionEvent } from '../core/agent/index.js';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { MetricsCollector } from './metrics.js';
import { C, bold, stateColor, fillLine, markdownTheme, editorTheme } from './theme.js';
import type { Config } from '../config/types.js';
import { getLspStatus } from '../config/lsp-status.js';
import { SessionStore } from '../core/session/store.js';

export interface TuiAppOptions {
  config: Config;
  sessionStore?: SessionStore;
}
// ─── Components ───────────────────────────────────────────────────────────────

class HintLine implements Component {
  private debugMode = false;
  setDebugMode(v: boolean): void {
    this.debugMode = v;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const debugLabel = this.debugMode ? C.ok(' [调试开]') : C.dim(' 调试');
    const line =
      '  ' +
      C.hintKey('Ctrl+C') +
      C.dim(' 退出') +
      '   ' +
      C.hintKey('Esc') +
      C.dim(' 中断') +
      '   ' +
      C.hintKey('Tab') +
      C.dim(' 展开/折叠思考') +
      '   ' +
      C.hintKey('d') +
      debugLabel;
    return [truncateToWidth(line, width)];
  }
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1) + 'M';
}

class HeaderLine implements Component {
  private cwd: string;
  private branch: string;
  private model: string;
  private state = 'IDLE';
  private taskLabel = '';
  private totalPromptTokens = 0;
  private totalResponseTokens = 0;
  private latestContextTokens = 0;
  private contextWindow = 0;
  private provider = '';
  private tier = '';

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

  setProviderInfo(provider: string, tier: string, contextWindow: number): void {
    this.provider = provider;
    this.tier = tier.toLowerCase();
    this.contextWindow = contextWindow;
  }

  updateTokenStats(promptTokens: number, responseTokens: number, contextTokens: number): void {
    this.totalPromptTokens += promptTokens;
    this.totalResponseTokens += responseTokens;
    this.latestContextTokens = contextTokens;
  }

  resetTaskStats(): void {
    this.totalPromptTokens = 0;
    this.totalResponseTokens = 0;
    this.latestContextTokens = 0;
  }

  getState(): string {
    return this.state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const leftParts = [C.headerCwd(this.cwd), ...(this.branch ? [C.headerBranch(this.branch)] : [])];
    const left = leftParts.join(C.headerSep('  │  '));

    const rightParts: string[] = [];

    if (this.totalPromptTokens > 0 || this.totalResponseTokens > 0) {
      rightParts.push(
        C.headerTokenUp('↑' + fmtTokens(this.totalPromptTokens)) +
          ' ' +
          C.headerTokenDown('↓' + fmtTokens(this.totalResponseTokens)),
      );
    }

    if (this.contextWindow > 0) {
      const pct = (this.latestContextTokens / this.contextWindow) * 100;
      const pctStr = pct.toFixed(1) + '%/' + fmtTokens(this.contextWindow);
      const ctxColor = pct >= 90 ? C.headerCtxCrit : pct >= 70 ? C.headerCtxWarn : C.dim;
      rightParts.push(ctxColor(pctStr));
    } else if (this.latestContextTokens > 0) {
      rightParts.push(C.dim('ctx ' + fmtTokens(this.latestContextTokens)));
    }

    if (this.provider) rightParts.push(C.headerProvider('(' + this.provider + ')'));

    const modelTierPart = this.tier
      ? C.headerModel(this.model) + ' ' + C.headerTier('• ' + this.tier)
      : C.headerModel(this.model);
    rightParts.push(modelTierPart);

    rightParts.push(stateColor(this.state)(this.state + this.taskLabel));

    const right = rightParts.join(C.headerSep('  '));
    const leftW = visibleWidth(left);
    const rightW = visibleWidth(right);
    const gap = Math.max(1, width - leftW - rightW - 2);
    const line = ' ' + left + ' '.repeat(gap) + right + ' ';
    return [truncateToWidth(line, width)];
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
    const innerWidth = Math.max(1, width - 4);
    const words = this.text.split(' ');
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? current + ' ' + word : word;
      if (visibleWidth(candidate) > innerWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
    if (lines.length === 0) lines.push('');
    const pad = truncateToWidth(C.userMsgBg(' '.repeat(width)), width);
    const contentLines = lines.map((l) => {
      const truncated = truncateToWidth(l, innerWidth);
      const padded = truncated + ' '.repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
      return truncateToWidth(C.userMsgBg('  ' + C.userText(padded) + '  '), width);
    });
    return ['', pad, ...contentLines, pad, ''];
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
    if (!this.expanded) {
      return ['  ' + C.dimItalic('Thinking...')];
    }
    const lines: string[] = [];
    for (const line of this.content.split('\n')) {
      lines.push('  ' + C.dimItalic(truncateToWidth(line, width - 4)));
    }
    if (lines.length > 0) lines.push('');
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
      result.push(fillLine('  ' + truncateToWidth(line, innerWidth), width, visibleWidth));
    }
    if (result.length > 0) {
      result.push('');
    }
    return result;
  }
}

// ─── ToolExecutionBlock ───────────────────────────────────────────────────────

function fmtToolArgs(tool: string, args?: Record<string, unknown>): string {
  if (!args || tool === 'complete') return '';
  for (const key of ['filePath', 'path', 'file', 'command', 'cmd', 'query']) {
    const v = args[key];
    if (typeof v === 'string') return v.slice(0, 60);
  }
  const first = Object.values(args).find((v) => typeof v === 'string');
  return typeof first === 'string' ? first.slice(0, 60) : '';
}

class ToolExecutionBlock implements Component {
  private tool: string;
  private argStr: string;
  private resultText = '';
  status: 'pending' | 'ok' | 'error' = 'pending';
  expanded = false;

  constructor(tool: string, args?: Record<string, unknown>) {
    this.tool = tool;
    this.argStr = fmtToolArgs(tool, args);
  }

  setResult(isError: boolean, output?: string): void {
    this.status = isError ? 'error' : 'ok';
    this.resultText = output ?? '';
  }

  setExpanded(v: boolean): void {
    this.expanded = v;
  }

  invalidate(): void {}

  private bgFn(): (s: string) => string {
    if (this.status === 'error') return C.toolErrorBg;
    if (this.status === 'ok') return C.toolSuccessBg;
    return C.toolPendingBg;
  }

  render(width: number): string[] {
    const bg = this.bgFn();
    const mark = this.status === 'ok' ? C.ok('✓') : this.status === 'error' ? C.err('✗') : C.pending('…');
    const namePad = (this.tool + '                ').slice(0, 12);
    const nameStr = bold(C.toolTitle(namePad));
    const maxArgW = Math.max(0, width - 14 - 6);
    const argStr = this.argStr ? C.toolArg(truncateToWidth(this.argStr, maxArgW)) : '';
    const resultLines = this.resultText ? this.resultText.split('\n') : [];
    const hint =
      !this.expanded && resultLines.length > 0 && this.status !== 'pending'
        ? C.dim(` (${resultLines.length} lines)`)
        : '';
    const titleContent = ' ' + nameStr + argStr + hint;
    const maxTitleW = Math.max(1, width - 3);
    const truncatedTitle = truncateToWidth(titleContent, maxTitleW);
    const truncatedTitleW = visibleWidth(truncatedTitle);
    const gap = Math.max(1, width - truncatedTitleW - 2);
    const titleLine = truncateToWidth(bg(truncatedTitle + ' '.repeat(gap) + mark + ' '), width);

    if (!this.expanded || resultLines.length === 0) return [titleLine];

    const contentLines = resultLines.slice(0, 100).map((l) => {
      const inner = truncateToWidth(l, width - 2);
      return truncateToWidth(bg(' ' + C.toolOutput(inner) + ' '), width);
    });
    return [titleLine, ...contentLines];
  }
}

// ─── AssistantTurn ────────────────────────────────────────────────────────────

class LlmTurn {
  debugBlock: DebugBlock | null = null;
  thinkingBlock: ThinkingBlock | null = null;
  outputComp: LlmOutput | null = null;
  toolLines: ToolExecutionBlock[] = [];
  toolMap = new Map<string, ToolExecutionBlock>();

  setDebug(systemPrompt: string, userPrompt: string): void {
    this.debugBlock = new DebugBlock(systemPrompt, userPrompt);
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

  addTool(id: string, tool: string, args?: Record<string, unknown>): ToolExecutionBlock {
    const block = new ToolExecutionBlock(tool, args);
    this.toolLines.push(block);
    this.toolMap.set(id, block);
    return block;
  }

  resolveTool(id: string, isError: boolean, output?: string): void {
    this.toolMap.get(id)?.setResult(isError, output);
  }

  invalidate(): void {
    this.thinkingBlock?.invalidate();
    this.outputComp?.invalidate();
    for (const t of this.toolLines) t.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    if (this.debugBlock) lines.push(...this.debugBlock.render(width));
    if (this.thinkingBlock) lines.push(...this.thinkingBlock.render(width));
    if (this.outputComp) lines.push(...this.outputComp.render(width));
    for (const tl of this.toolLines) lines.push(...tl.render(width));
    return lines;
  }
}

class AssistantTurn implements Component {
  private state: string;
  private llmTurns: LlmTurn[] = [];
  private currentLlmTurn: LlmTurn | null = null;

  constructor(state: string) {
    this.state = state;
  }

  private ensureLlmTurn(): LlmTurn {
    if (!this.currentLlmTurn) {
      this.currentLlmTurn = new LlmTurn();
      this.llmTurns.push(this.currentLlmTurn);
    }
    return this.currentLlmTurn;
  }

  startLlmTurn(systemPrompt: string, userPrompt: string, debugMode: boolean): DebugBlock | null {
    this.currentLlmTurn = new LlmTurn();
    this.llmTurns.push(this.currentLlmTurn);
    this.currentLlmTurn.setDebug(systemPrompt, userPrompt);
    if (this.currentLlmTurn.debugBlock) {
      this.currentLlmTurn.debugBlock.setExpanded(debugMode);
      return this.currentLlmTurn.debugBlock;
    }
    return null;
  }

  get thinkingBlock(): ThinkingBlock | null {
    return this.currentLlmTurn?.thinkingBlock ?? null;
  }

  updateThinking(content: string): void {
    this.ensureLlmTurn().updateThinking(content);
  }

  updateOutput(content: string): void {
    this.ensureLlmTurn().updateOutput(content);
  }

  finalizeThinking(content: string): void {
    this.ensureLlmTurn().finalizeThinking(content);
  }

  finalizeOutput(content: string): void {
    this.ensureLlmTurn().finalizeOutput(content);
  }

  addTool(id: string, tool: string, args?: Record<string, unknown>): ToolExecutionBlock {
    return this.ensureLlmTurn().addTool(id, tool, args);
  }

  resolveTool(id: string, isError: boolean, output?: string): void {
    for (const t of this.llmTurns) {
      if (t.toolMap.has(id)) {
        t.resolveTool(id, isError, output);
        return;
      }
    }
  }

  invalidate(): void {
    for (const t of this.llmTurns) t.invalidate();
  }

  render(width: number): string[] {
    const colorFn = stateColor(this.state);
    const stateLabel = truncateToWidth('  ' + colorFn(this.state), width);
    const lines: string[] = ['', stateLabel];
    for (const t of this.llmTurns) lines.push(...t.render(width));
    return lines;
  }
}

// ─── SampleTurn ───────────────────────────────────────────────────────────────

class SampleTurn implements Component {
  private index: number;
  private total: number;
  private thinking = '';
  private steps: import('../core/types.js').Step[] | null = null;
  private failed = false;
  private streaming = true;
  expanded = false;

  constructor(index: number, total: number) {
    this.index = index;
    this.total = total;
  }

  updateThinking(content: string): void {
    this.thinking = content;
  }

  complete(steps: import('../core/types.js').Step[]): void {
    this.steps = steps;
    this.streaming = false;
  }

  fail(): void {
    this.failed = true;
    this.streaming = false;
  }

  toggle(): void {
    this.expanded = !this.expanded;
  }

  setExpanded(v: boolean): void {
    this.expanded = v;
  }

  invalidate(): void {}

  private isLast(): boolean {
    return this.index === this.total - 1;
  }

  render(width: number): string[] {
    const branch = this.isLast() ? '└' : '├';
    const label = C.dim(`  ${branch} 方案 ${this.index + 1}`);

    let status: string;
    if (this.failed) {
      status = C.err('✗');
    } else if (this.streaming) {
      status = C.dim('⠿');
    } else if (this.steps !== null) {
      const chain = this.steps.map((s) => s.state).join(' → ');
      status = C.ok('✓') + C.dim('  ' + chain);
    } else {
      status = C.dim('?');
    }

    const arrow = this.expanded ? '▾' : '▸';
    const toggle = C.dim(` ${arrow}`);
    const header = truncateToWidth(label + toggle + '  ' + status, width);
    const lines: string[] = [header];

    if (this.expanded && this.thinking) {
      for (const line of this.thinking.split('\n').slice(0, 20)) {
        lines.push('  │  ' + C.dimItalic(truncateToWidth(line, width - 8)));
      }
    }

    return lines;
  }
}

// ─── SamplingBlock ────────────────────────────────────────────────────────────

class SamplingBlock implements Component {
  private sampleTurns: SampleTurn[] = [];
  private extraLines: string[] = [];

  addSample(turn: SampleTurn): void {
    this.sampleTurns.push(turn);
  }

  getSample(index: number): SampleTurn | undefined {
    return this.sampleTurns[index];
  }

  addLine(text: string): void {
    this.extraLines.push(text);
  }

  allSampleTurns(): SampleTurn[] {
    return this.sampleTurns;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.sampleTurns.length === 0 && this.extraLines.length === 0) return [];
    const lines: string[] = ['', C.dim('  ⚡ Heavy Thinking')];
    for (const turn of this.sampleTurns) lines.push(...turn.render(width));
    for (const l of this.extraLines) lines.push(truncateToWidth(C.dim(l), width));
    lines.push('');
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
  private allSampleTurns: SampleTurn[] = [];
  private allToolBlocks: ToolExecutionBlock[] = [];
  private conversationHistory: AgentMessage[] = [];
  private sessionStore: SessionStore;
  private currentAgent: import('../core/agent/index.js').ReactAgent | null = null;
  private pendingClarificationAgent: import('../core/agent/index.js').ReactAgent | null = null;

  constructor(private options: TuiAppOptions) {
    const terminal = new ProcessTerminal();
    this.tui = new TUI(terminal);
    this.header = new HeaderLine(options.config.model.name);
    this.hintLine = new HintLine();

    {
      const provider = options.config.model.provider;
      const modelSize = options.config.model.modelSize;
      const tier = modelSize != null ? (modelSize <= 9 ? 'small' : modelSize <= 30 ? 'medium' : 'large') : '';
      this.header.setProviderInfo(provider, tier, 0);
    }

    if (options.sessionStore) {
      this.sessionStore = options.sessionStore;
      this.conversationHistory = options.sessionStore.load();
    } else {
      this.sessionStore = SessionStore.create(process.cwd());
    }

    this.editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
    this.editor.onSubmit = (value) => this.handleSubmit(value);

    this.tui.addInputListener((data) => {
      if (data === '\x03' || matchesKey(data, 'ctrl+c')) {
        this.stop();
        return { consume: true };
      }
      if (data === '\x1b') {
        if (this.currentAgent) {
          this.currentAgent.abort();
          this.currentAgent = null;
        }
        return { consume: true };
      }
      if (data === '\t') {
        const expandables = [...this.allThinkingBlocks, ...this.allSampleTurns, ...this.allToolBlocks];
        if (expandables.length > 0) {
          const anyExpanded = expandables.some((b) => b.expanded);
          for (const b of expandables) b.setExpanded(!anyExpanded);
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
    this.tui.addChild(this.header);
    this.tui.addChild(this.hintLine);
  }

  start(): void {
    this.running = true;

    process.on('SIGINT', () => this.stop());
    this.tui.setFocus(this.editor);
    this.tui.start();

    const lspStatus = getLspStatus(process.cwd());
    if (lspStatus.status === 'not_installed') {
      this.insertBefore(new Text(C.err(`  ✗ LSP: ${lspStatus.server} 未安装（运行 local-agent setup 安装）`), 0, 0));
    }

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
    const debugShownForState = new Set<string>();
    let currentState = 'REASON';

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

    let samplingBlock: SamplingBlock | null = null;

    return (event: ExecutionEvent): void => {
      if (event.type === 'state_change') {
        const prevState = currentState;
        currentState = event.to;
        this.header.setState(event.to);
        loader.setMessage(`[${event.to}]`);
        this.metrics.recordStateExit(taskId, event.from);
        this.metrics.recordStateEntry(taskId, event.to);
        if (event.to !== 'DONE' && event.to !== 'SAMPLING' && event.to !== prevState) {
          const turn = new AssistantTurn(event.to);
          const idx = this.tui.children.indexOf(loader);
          this.tui.children.splice(idx, 0, turn);
          setCurrentTurn(turn);
        }
      } else if (event.type === 'turn_start') {
        const turn = ensureCurrentTurn();
        const alreadyShown = debugShownForState.has(currentState);
        const debugBlock = turn.startLlmTurn(event.systemPrompt, event.userPrompt, this.debugMode && !alreadyShown);
        if (debugBlock) {
          this.allDebugBlocks.push(debugBlock);
          debugShownForState.add(currentState);
        }
      } else if (event.type === 'message_thinking_update') {
        const turn = ensureCurrentTurn();
        turn.updateThinking(event.content);
        if (turn.thinkingBlock && !this.allThinkingBlocks.includes(turn.thinkingBlock)) {
          this.allThinkingBlocks.push(turn.thinkingBlock);
        }
      } else if (event.type === 'message_update') {
        ensureCurrentTurn().updateOutput(event.content);
      } else if (event.type === 'message_thinking_end') {
        const turn = ensureCurrentTurn();
        turn.finalizeThinking(event.content);
        if (turn.thinkingBlock && !this.allThinkingBlocks.includes(turn.thinkingBlock)) {
          this.allThinkingBlocks.push(turn.thinkingBlock);
        }
      } else if (event.type === 'message_end') {
        ensureCurrentTurn().finalizeOutput(event.content);
      } else if (event.type === 'tool_execution_start') {
        const turn = ensureCurrentTurn();
        const toolId = `${Date.now()}-${event.tool}`;
        pendingTools.set(toolId, event.tool);
        const block = turn.addTool(toolId, event.tool, event.args);
        this.allToolBlocks.push(block);
        loader.setMessage(`[${event.tool}]`);
        this.metrics.recordToolCall(taskId, event.tool);
      } else if (event.type === 'tool_execution_end') {
        const entry = [...pendingTools.entries()].reverse().find(([, v]) => v === event.tool);
        const turn = getCurrentTurn();
        if (entry && turn) {
          turn.resolveTool(entry[0], event.isError, event.output);
          pendingTools.delete(entry[0]);
        }
      } else if (event.type === 'session_info') {
        this.header.setProviderInfo(event.provider, event.tier, event.contextWindow);
      } else if (event.type === 'turn_end') {
        this.metrics.recordLLMCall(taskId, event.promptLen, event.responseLen);
        this.header.updateTokenStats(event.promptLen, event.responseLen, event.contextTokens);
      } else if (event.type === 'task_start') {
        this.header.setState(event.description.slice(0, 20), event.taskIndex + 1, event.taskTotal);
      } else if (event.type === 'task_end') {
        void event;
      } else if (event.type === 'clarification_needed') {
        const questions = event.questions.map((q, i) => `  ${i + 1}. ${q}`).join('\n');
        this.insertBefore(new Text(C.dim('  需要确认以下信息：\n') + questions, 0, 0));
        this.pendingClarificationAgent = this.currentAgent;
        this.editor.disableSubmit = false;
      } else if (event.type === 'deliberation_start') {
        samplingBlock = new SamplingBlock();
        const idx = this.tui.children.indexOf(loader);
        this.tui.children.splice(idx, 0, samplingBlock);
      } else if (event.type === 'sample_start') {
        if (samplingBlock) {
          const turn = new SampleTurn(event.index, event.total);
          samplingBlock.addSample(turn);
          this.allSampleTurns.push(turn);
        }
      } else if (event.type === 'sample_thinking') {
        samplingBlock?.getSample(event.index)?.updateThinking(event.content);
      } else if (event.type === 'sample_complete') {
        samplingBlock?.getSample(event.index)?.complete(event.steps);
      } else if (event.type === 'sample_failed') {
        samplingBlock?.getSample(event.index)?.fail();
      } else if (event.type === 'sampling_progress') {
        void event;
      } else if (event.type === 'deliberation_refinement') {
        const label =
          event.verdict === 'converged'
            ? '收敛'
            : event.verdict === 'BETTER'
              ? '更优'
              : event.verdict === 'SAME'
                ? '相同'
                : '较差';
        samplingBlock?.addLine(`  ↻ Refinement ${event.round}: ${label}`);
      } else if (event.type === 'deliberation_complete') {
        void event;
      } else if (event.type === 'deliberation_fallback') {
        samplingBlock?.addLine(`  ⚠ ${event.reason}`);
      } else if (event.type === 'deliberation_clarification') {
        samplingBlock?.addLine(`  ? ${event.question}`);
        this.pendingClarificationAgent = this.currentAgent;
        this.editor.disableSubmit = false;
      } else if (event.type === 'parallel_start') {
        this.header.setState(`⇉ 并行 ${event.stepCount} 步`, undefined, undefined);
      } else if (event.type === 'parallel_complete') {
        void event;
      } else if (event.type === 'sampling_expand') {
        samplingBlock?.addLine(`  ↻ 第${event.round}轮分歧，扩展采样`);
      } else if (event.type === 'sampling_stopped') {
        const labels: Record<typeof event.reason, string> = {
          converged: '收敛',
          max_count: '达到上限',
          max_rounds: '达到最大轮数',
          no_new_info: '无新信息',
        };
        samplingBlock?.addLine(`  ✓ 采样完成（${labels[event.reason]}）`);
      }

      this.tui.requestRender();
    };
  }

  private async handleSubmit(value: string): Promise<void> {
    const input = value.trim();
    if (!input) return;

    this.editor.disableSubmit = true;
    this.editor.addToHistory(input);
    this.allThinkingBlocks = [];
    this.allSampleTurns = [];
    this.allDebugBlocks = [];
    this.allToolBlocks = [];
    this.header.resetTaskStats();
    this.insertBefore(new UserMessage(input));
    this.tui.requestRender();

    if (this.pendingClarificationAgent) {
      const agent = this.pendingClarificationAgent;
      this.pendingClarificationAgent = null;
      agent.provideClarification(input);
      return;
    }

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
    this.currentAgent = agent;
    let aborted = false;
    try {
      const result = await agent.run(input, this.options.config, onEvent, this.conversationHistory);
      loader.stop();
      this.tui.removeChild(loader);
      this.metrics.recordStateExit(taskId, result.state);
      this.metrics.finishTask(taskId, result.success);

      let display = '';
      if (result.output && result.output !== 'Task completed') {
        display = result.output;
        try {
          const parsed = JSON.parse(result.output) as Record<string, unknown>;
          const text =
            typeof parsed['answer'] === 'string'
              ? parsed['answer']
              : typeof parsed['report'] === 'string'
                ? parsed['report']
                : typeof parsed['summary'] === 'string'
                  ? parsed['summary']
                  : null;
          if (text) {
            display = text;
          } else if (Array.isArray(parsed['edited'])) {
            const files = (parsed['edited'] as string[]).join(', ');
            const lines = typeof parsed['linesChanged'] === 'number' ? `，${parsed['linesChanged']} 行` : '';
            display = `已修改：${files}${lines}`;
          } else if (Array.isArray(parsed['locations'])) {
            const locs = parsed['locations'] as Array<{ file: string; startLine?: number }>;
            display = locs.map((l) => `${l.file}${l.startLine ? `:${l.startLine}` : ''}`).join(', ');
          } else {
            display = '';
          }
        } catch (_) {
          void _;
        }
        if (display) {
          this.insertBefore(new Text(display, 0, 0));
        }
      }

      const ts = Date.now();
      const userMsg = { role: 'user' as const, content: input, timestamp: ts };
      this.conversationHistory.push(userMsg as import('@mariozechner/pi-agent-core').AgentMessage);
      this.sessionStore.append({ type: 'message', ...userMsg });
      if (display) {
        const assistantMsg = { role: 'user' as const, content: `[Assistant]: ${display}`, timestamp: ts + 1 };
        this.conversationHistory.push(assistantMsg as import('@mariozechner/pi-agent-core').AgentMessage);
        this.sessionStore.append({ type: 'message', ...assistantMsg });
      }
    } catch (err) {
      loader.stop();
      this.tui.removeChild(loader);
      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' || err.message.includes('abort') || err.message.includes('Abort'));
      if (isAbort) {
        aborted = true;
        this.metrics.finishTask(taskId, false);
        this.insertBefore(new Text(C.dim('  ⊘  已中断'), 0, 0));
      } else {
        this.metrics.finishTask(taskId, false);
        this.insertBefore(new Text(C.err(`  ✗  错误: ${String(err)}`), 0, 0));
      }
    } finally {
      this.currentAgent = null;
    }

    const m = this.metrics.getMetrics(taskId);
    if (m) {
      const tokens = fmtTokens(m.estimatedTokens);
      const llmCalls = m.llmCalls;
      if (m.success) {
        this.insertBefore(
          new Text('\n' + C.successText('  ✓  完成') + C.dim(`  成功率 100%  llm×${llmCalls}  tokens≈${tokens}`), 0, 0),
        );
      } else if (!aborted) {
        this.insertBefore(new Text('\n' + C.err('  ✗  失败') + C.dim(`  llm×${llmCalls}  tokens≈${tokens}`), 0, 0));
      }
    }
    this.header.setState('IDLE');
    this.editor.disableSubmit = false;
    this.tui.requestRender();
  }
}

export function createTuiApp(options: TuiAppOptions): TuiApp {
  return new TuiApp(options);
}
