import { truncateToWidth, visibleWidth } from '@mariozechner/pi-tui';
import type { Component } from '@mariozechner/pi-tui';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { C, stateColor } from '../theme.js';

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1) + 'M';
}

export class HintLine implements Component {
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
      C.hintKey('Ctrl+T') +
      C.dim(' 思考') +
      '   ' +
      C.hintKey('Ctrl+O') +
      C.dim(' 工具') +
      '   ' +
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

  setState(state: string, taskIndex?: number, taskTotal?: number): void {
    this.state = state;
    this.taskLabel = taskTotal != null && taskTotal > 0 ? ` [${taskIndex}/${taskTotal}]` : '';
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
