import type { Component } from '@mariozechner/pi-tui';

export class DynamicBorder implements Component {
  private color: (str: string) => string;

  constructor(color: (str: string) => string = (s) => s) {
    this.color = color;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [this.color('─'.repeat(Math.max(1, width)))];
  }
}
