import { Container, Text } from '@mariozechner/pi-tui';

export type LogLevel = 'info' | 'state' | 'tool' | 'success' | 'error' | 'task';

const LEVEL_PREFIX: Record<LogLevel, string> = {
  task:    '─── ',
  state:   '  ',
  tool:    '    > ',
  info:    '  ',
  success: '  ✅ ',
  error:   '  ❌ ',
};

export class MessageLog extends Container {
  private maxEntries: number;

  constructor(maxEntries = 200) {
    super();
    this.maxEntries = maxEntries;
  }

  append(message: string, level: LogLevel = 'info'): void {
    const prefix = LEVEL_PREFIX[level];
    const text = new Text(prefix + message, 0, 0);
    this.addChild(text);

    if (this.children.length > this.maxEntries) {
      this.children.shift();
    }
  }

  clear(): void {
    this.children = [];
  }
}
