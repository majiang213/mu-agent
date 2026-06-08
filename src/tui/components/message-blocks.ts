import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import { Markdown } from '@earendil-works/pi-tui';
import { C, fillLine, markdownTheme } from '../theme.js';

// ─── UserMessage ──────────────────────────────────────────────────────────────

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

// ─── ThinkingBlock ────────────────────────────────────────────────────────────

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

// ─── DebugBlock ───────────────────────────────────────────────────────────────

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
