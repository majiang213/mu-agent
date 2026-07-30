import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { MU_AGENT_DIR } from '../../config/defaults.js';

export interface Checkpoint {
  filePath: string;
  originalContent: string;
  timestamp: number;
  /**
   * Identity of the step/branch that created this checkpoint — the step's
   * stateMachine instance. Parallel branches hold clones, so owner identity
   * is unique per branch; sequential steps share an owner but never have
   * pending checkpoints at each other's retry windows (a successful edit's
   * checkpoint is cleared by its post-check).
   */
  owner?: unknown;
}

/**
 * File checkpointing before modification.
 *
 * The store is SHARED across parallel branches (architecture review
 * 2026-07-30): rollback must see every branch's edits, and retry cleanup
 * must only ever touch the retrying step's own checkpoints — use
 * restoreAndClearWhere, never a store-wide wipe.
 */
export class SafeModifier {
  private checkpoints: Map<string, Checkpoint> = new Map();
  private checkpointDir: string;

  constructor(checkpointDir = `${MU_AGENT_DIR}/checkpoints`) {
    this.checkpointDir = checkpointDir;
  }

  private escapePath(filePath: string): string {
    return filePath.replace(/%/g, '%%').replace(/[/\\]/g, '%');
  }

  private checkpointPathFor(checkpoint: Checkpoint): string {
    return join(this.checkpointDir, `${checkpoint.timestamp}_${this.escapePath(checkpoint.filePath)}.bak`);
  }

  /**
   * Create checkpoint before modification
   */
  async createCheckpoint(filePath: string, owner?: unknown): Promise<void> {
    if (!existsSync(filePath)) return;
    const content = await readFile(filePath, 'utf-8');

    const checkpoint: Checkpoint = {
      filePath,
      originalContent: content,
      timestamp: Date.now(),
      owner,
    };

    this.checkpoints.set(filePath, checkpoint);

    // Also save to disk for persistence
    await this.saveToDisk(checkpoint);
  }

  /**
   * Restore file from checkpoint
   */
  async restore(filePath: string): Promise<boolean> {
    const checkpoint = this.checkpoints.get(filePath);

    if (!checkpoint) {
      // Try to load from disk
      const diskCheckpoint = await this.loadFromDisk(filePath);
      if (!diskCheckpoint) return false;

      await writeFile(filePath, diskCheckpoint.originalContent, 'utf-8');
      return true;
    }

    await writeFile(filePath, checkpoint.originalContent, 'utf-8');
    return true;
  }

  /**
   * Check if checkpoint exists
   */
  hasCheckpoint(filePath: string): boolean {
    return this.checkpoints.has(filePath);
  }

  /**
   * Get checkpoint info
   */
  getCheckpoint(filePath: string): Checkpoint | undefined {
    return this.checkpoints.get(filePath);
  }

  /**
   * Clear a single checkpoint's in-memory entry. The .bak file is kept on
   * disk on purpose: rollbackEditedFiles relies on restore()'s disk fallback
   * even after a successful post-check cleared the in-memory entry.
   */
  clearCheckpoint(filePath: string): void {
    this.checkpoints.delete(filePath);
  }

  /**
   * Restore then clear every checkpoint created by `owner` (undo a failed
   * step's partial edits before retrying it), leaving all other checkpoints
   * — other steps and parallel siblings — and their .bak files intact.
   */
  async restoreAndClearWhere(owner: unknown): Promise<void> {
    for (const [filePath, checkpoint] of [...this.checkpoints.entries()]) {
      if (checkpoint.owner !== owner) continue;
      await writeFile(filePath, checkpoint.originalContent, 'utf-8');
      try {
        unlinkSync(this.checkpointPathFor(checkpoint));
      } catch {
        // .bak already gone — non-fatal
      }
      this.checkpoints.delete(filePath);
    }
  }

  /**
   * Save checkpoint to disk
   */
  private async saveToDisk(checkpoint: Checkpoint): Promise<void> {
    const checkpointPath = this.checkpointPathFor(checkpoint);
    await mkdir(dirname(checkpointPath), { recursive: true });
    await writeFile(checkpointPath, checkpoint.originalContent, 'utf-8');
  }

  private async loadFromDisk(filePath: string): Promise<Checkpoint | null> {
    if (!existsSync(this.checkpointDir)) return null;
    try {
      const entries = await readdir(this.checkpointDir);
      const escapedPath = this.escapePath(filePath);
      const matching = entries
        .filter((e) => e.endsWith(`_${escapedPath}.bak`))
        .sort()
        .reverse();
      const latest = matching[0];
      if (!latest) return null;
      const content = await readFile(join(this.checkpointDir, latest), 'utf-8');
      const tsMatch = basename(latest).match(/^(\d+)_/);
      return {
        filePath,
        originalContent: content,
        timestamp: tsMatch?.[1] ? parseInt(tsMatch[1], 10) : 0,
      };
    } catch {
      return null;
    }
  }
}
