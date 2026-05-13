import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Checkpoint for file modification
 */
export interface Checkpoint {
  filePath: string;
  originalContent: string;
  timestamp: number;
}

/**
 * Safe modifier with checkpoint support
 */
export class SafeModifier {
  private checkpoints: Map<string, Checkpoint> = new Map();
  private checkpointDir: string;

  constructor(checkpointDir = '.local-agent/checkpoints') {
    this.checkpointDir = checkpointDir;
  }

  /**
   * Create checkpoint before modification
   */
  async createCheckpoint(filePath: string): Promise<void> {
    const content = await readFile(filePath, 'utf-8');
    
    const checkpoint: Checkpoint = {
      filePath,
      originalContent: content,
      timestamp: Date.now(),
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
   * Clear checkpoint after successful modification
   */
  clearCheckpoint(filePath: string): void {
    this.checkpoints.delete(filePath);
  }

  /**
   * Clear all checkpoints
   */
  clearAll(): void {
    this.checkpoints.clear();
  }

  /**
   * Save checkpoint to disk
   */
  private async saveToDisk(checkpoint: Checkpoint): Promise<void> {
    const checkpointPath = join(
      this.checkpointDir,
      `${checkpoint.timestamp}_${checkpoint.filePath.replace(/[/\\]/g, '_')}.bak`
    );

    await mkdir(dirname(checkpointPath), { recursive: true });
    await writeFile(checkpointPath, checkpoint.originalContent, 'utf-8');
  }

  private async loadFromDisk(filePath: string): Promise<Checkpoint | null> {
    if (!existsSync(this.checkpointDir)) return null;
    try {
      const entries = await readdir(this.checkpointDir);
      const escapedPath = filePath.replace(/[/\\]/g, '_');
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

/**
 * Create safe modifier instance
 */
export function createSafeModifier(checkpointDir?: string): SafeModifier {
  return new SafeModifier(checkpointDir);
}
