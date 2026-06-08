import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import { C, bold } from '../theme.js';

export function fmtToolArgs(tool: string, args?: Record<string, unknown>): string {
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
