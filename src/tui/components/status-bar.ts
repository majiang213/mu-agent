import { Container, Loader, Spacer, type TUI } from '@mariozechner/pi-tui';
import type { MetricsSummary } from '../../core/metrics.js';

export class StatusBar extends Container {
  private loader: Loader;
  private active = false;

  constructor(tui: TUI) {
    super();
    this.loader = new Loader(
      tui,
      (s) => s,
      (s) => s,
      '准备就绪',
    );
    this.addChild(new Spacer(1));
    this.addChild(this.loader);
  }

  start(message: string): void {
    this.active = true;
    this.loader.setMessage(message);
    this.loader.start();
  }

  update(message: string, summary?: MetricsSummary): void {
    if (!this.active) return;
    let msg = message;
    if (summary && summary.totalTasks > 0) {
      const tokens = Math.round(summary.avgTokens * summary.totalTasks);
      const dur = Math.round(summary.avgDurationMs * summary.totalTasks / 1000);
      msg += `  tokens≈${tokens}  ${dur}s`;
    }
    this.loader.setMessage(msg);
  }

  stop(): void {
    this.active = false;
    this.loader.stop();
    this.loader.setMessage('');
  }
}
