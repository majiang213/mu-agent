import Database from 'better-sqlite3';
import type { Model } from '@earendil-works/pi-ai';
import { writeEpisodeSync } from './episode.js';
import { processPendingSummaries as _processPendingSummaries } from './summarizer.js';
import { decaySemanticFacts } from './semantic.js';
import type { ExecutedStep, StateResult, Mission } from './types.js';

export { findGitRoot, initMemoryDb } from './db.js';
export { formatMemoryIndex } from './index-builder.js';
export { formatEpisodeDetail, fmtTime } from './episode.js';
export { graphRetrieve } from './retrieval.js';

export class MemoryStore {
  constructor(
    private db: Database.Database,
    private projectRoot: string,
    private model?: Model<'openai-completions'>,
  ) {
    decaySemanticFacts(db, projectRoot);
  }

  writeEpisodeSync(mission: Mission, allStepResults: ExecutedStep[], finalResult: StateResult): string {
    return writeEpisodeSync(this.db, mission, allStepResults, finalResult, this.projectRoot);
  }

  async processPendingSummaries(): Promise<void> {
    if (!this.model) return;
    await _processPendingSummaries(this.db, this.model, this.projectRoot);
  }
}
