import Database from 'better-sqlite3';
import type { Model } from '@earendil-works/pi-ai';
import { findGitRoot, initMemoryDb } from './db.js';
import { writeEpisodeSync, formatEpisodeDetail } from './episode.js';
import { processPendingSummaries as _processPendingSummaries } from './summarizer.js';
import { decaySemanticFacts } from './semantic.js';
import { graphRetrieve, formatMemoryIndex } from './retrieval.js';
import { episodeColumns, type EpisodeRow } from './types.js';
import type { ExecutedStep, StateResult } from '../types.js';
import type { Mission } from '../agent/types.js';

export { findGitRoot, initMemoryDb } from './db.js';

/**
 * MemoryStore — the real interface of the three-layer memory system
 * (episodes + entities + semantic facts over SQLite).
 *
 * Deepened from a pass-through facade (architecture review 2026-07-30,
 * candidate 8): consumers no longer hold raw db handles or re-thread
 * (db, projectRoot) through free functions — the store owns both, plus
 * index rendering and search.
 */
export class MemoryStore {
  constructor(
    private db: Database.Database,
    private projectRoot: string,
    private model?: Model<'openai-completions'>,
  ) {
    decaySemanticFacts(db, projectRoot);
  }

  /** Open (or create) the memory db for a workspace and return the store. */
  static open(cwd: string, model?: Model<'openai-completions'>): MemoryStore {
    const db = initMemoryDb(findGitRoot(cwd));
    return new MemoryStore(db, cwd, model);
  }

  writeEpisodeSync(mission: Mission, allStepResults: ExecutedStep[], finalResult: StateResult): string {
    return writeEpisodeSync(this.db, mission, allStepResults, finalResult, this.projectRoot);
  }

  /** ~200-token anchor injected into memory-capable states' system prompts. */
  index(): string {
    return formatMemoryIndex(this.db, this.projectRoot);
  }

  /** Keyword/entity/FTS search, formatted for the memory_search tool. */
  search(query: string): string {
    const rows = graphRetrieve(query, this.db, this.projectRoot);
    return rows.length > 0
      ? rows.map((r) => formatEpisodeDetail(r)).join('\n\n---\n\n')
      : `No memories found matching "${query}".`;
  }

  /** Exact lookup by short id; null when no episode matches. */
  searchById(shortId: string): string | null {
    const row = this.db
      .prepare(
        `
      SELECT ${episodeColumns()}
      FROM episodes
      WHERE project_root = ? AND REPLACE(id, '-', '') LIKE ?
      LIMIT 1
    `,
      )
      .get(this.projectRoot, `${shortId}%`) as EpisodeRow | undefined;
    return row ? formatEpisodeDetail(row) : null;
  }

  async processPendingSummaries(): Promise<void> {
    if (!this.model) return;
    await _processPendingSummaries(this.db, this.model, this.projectRoot);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* db already closed */
    }
  }
}
