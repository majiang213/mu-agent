import { EventEmitter } from 'node:events';
import type { VramUsage, VramWatcherConfig } from './types.js';
import { getVramUsage } from './collector.js';

/**
 * Watches VRAM usage and emits events when thresholds are exceeded
 */
export class VramWatcher extends EventEmitter {
  private config: Required<VramWatcherConfig>;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastUsage: VramUsage | null = null;

  constructor(config: VramWatcherConfig) {
    super();
    this.config = {
      intervalMs: config.intervalMs,
      warningThreshold: config.warningThreshold,
      criticalThreshold: config.criticalThreshold,
      onThresholdExceeded: config.onThresholdExceeded ?? (() => {}),
    };
  }

  /**
   * Start watching VRAM usage
   */
  start(): void {
    if (this.intervalId !== null) return;

    this.checkVram();

    this.intervalId = setInterval(() => {
      this.checkVram();
    }, this.config.intervalMs);
  }

  /**
   * Stop watching VRAM usage
   */
  stop(): void {
    if (this.intervalId === null) return;

    clearInterval(this.intervalId);
    this.intervalId = null;
  }

  /**
   * Get the last recorded VRAM usage
   */
  getLastUsage(): VramUsage | null {
    return this.lastUsage;
  }

  /**
   * Check current VRAM usage and emit events if thresholds exceeded
   */
  private checkVram(): void {
    const usage = getVramUsage();
    if (!usage) return;

    this.lastUsage = usage;

    if (usage.percentage >= this.config.criticalThreshold) {
      this.emit('critical', usage);
      this.config.onThresholdExceeded(usage);
    } else if (usage.percentage >= this.config.warningThreshold) {
      this.emit('warning', usage);
      this.config.onThresholdExceeded(usage);
    }

    this.emit('usage', usage);
  }

  /**
   * Check if watcher is currently running
   */
  isRunning(): boolean {
    return this.intervalId !== null;
  }
}
