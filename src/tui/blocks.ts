import { truncateToWidth, visibleWidth, wrapTextWithAnsi, Markdown } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import { execSync } from 'node:child_process';

import { C, bold, stateColor, fillLine, markdownTheme } from './theme.js';
import { fmtTokens } from './presenter.js';
import { directiveLabel } from '../core/agent/directives.js';
import type { StepDirective } from '../core/types.js';

/**
 * TUI components — pure render(width): string[] view classes, exported so
 * tests assert on render output instead of grepping app.ts source
 * (third-pass review, candidate 9). No component constructor performs I/O;
 * callers inject what the terminal/environment knows.
 */

/** Best-effort current git branch ('' outside a repo or on error). */
export function detectGitBranch(): string {
  try {
    return execSync('git branch --show-current', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export class HintLine implements Component {
  private debugMode = false;
  setDebugMode(v: boolean): void {
    this.debugMode = v;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const debugLabel = this.debugMode ? C.ok(' [debug on]') : C.dim(' debug');
    const line =
      '  ' +
      C.hintKey('Ctrl+C') +
      C.dim(' quit') +
      '  ' +
      C.hintKey('Esc') +
      C.dim(' interrupt') +
      '  ' +
      C.hintKey('Ctrl+T') +
      C.dim(' thinking') +
      '  ' +
      C.hintKey('Ctrl+O') +
      C.dim(' tools') +
      '  ' +
      C.hintKey('Ctrl+D') +
      debugLabel;
    return [truncateToWidth(line, width)];
  }
}

export class HeaderLine implements Component {
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

  constructor(model: string, cwd: string, branch: string) {
    this.model = model;
    this.cwd = cwd;
    this.branch = branch;
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

export class UserMessage implements Component {
  private text: string;
  constructor(text: string) {
    this.text = text;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    const lines = wrapTextWithAnsi(this.text, innerWidth);
    if (lines.length === 0) lines.push('');
    const pad = truncateToWidth(C.userMsgBg(' '.repeat(width)), width);
    const contentLines = lines.map((l) => {
      const truncated = truncateToWidth(l, innerWidth, '...', true);
      return truncateToWidth(C.userMsgBg('  ' + C.userText(truncated) + '  '), width);
    });
    return ['', pad, ...contentLines, pad, ''];
  }
}

export class ThinkingBlock implements Component {
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

export class DebugBlock implements Component {
  private systemPrompt: string;
  private userPrompt: string;
  expanded = false;
  visible = false;

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

  setVisible(v: boolean): void {
    this.visible = v;
    if (!v) this.expanded = false;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.visible) return [];
    const arrow = this.expanded ? '▾' : '▸';
    const header = '  ' + C.dimItalic(arrow + ' debug: raw input');
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

export class LlmOutput implements Component {
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

function fmtToolArgs(tool: string, args?: Record<string, unknown>): string {
  if (!args || tool === 'complete') return '';
  for (const key of ['filePath', 'path', 'file', 'command', 'cmd', 'query']) {
    const v = args[key];
    if (typeof v === 'string') return v.slice(0, 60);
  }
  const first = Object.values(args).find((v) => typeof v === 'string');
  return typeof first === 'string' ? first.slice(0, 60) : '';
}

export class ToolExecutionBlock implements Component {
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
      !this.expanded && resultLines.length > 0 && this.status !== 'pending' && this.tool !== 'complete'
        ? C.dimK(` (${resultLines.length} lines)`)
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

export class LlmTurn {
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

export class AssistantTurn implements Component {
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
    if (debugMode) {
      this.currentLlmTurn.setDebug(systemPrompt, userPrompt);
      if (this.currentLlmTurn.debugBlock) {
        this.currentLlmTurn.debugBlock.setVisible(debugMode);
        this.currentLlmTurn.debugBlock.setExpanded(debugMode);
        return this.currentLlmTurn.debugBlock;
      }
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

export class SampleTurn implements Component {
  private index: number;
  private total: number;
  private thinking = '';
  private steps: StepDirective[] | null = null;
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

  complete(steps: StepDirective[]): void {
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
    const label = C.dim(`  ${branch} plan ${this.index + 1}`);

    let status: string;
    if (this.failed) {
      status = C.err('✗');
    } else if (this.streaming) {
      status = C.dim('⠿');
    } else if (this.steps !== null) {
      const chain = this.steps.length > 0 ? this.steps.map(directiveLabel).join(' → ') : 'direct answer';
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

export class SamplingBlock implements Component {
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
