import Database from 'better-sqlite3';
import type { EpisodeRow } from './types.js';
import { detectActionWords, extractEntitiesForQuery } from './extractor.js';

export function graphRetrieve(userInput: string, db: Database.Database, projectRoot: string): EpisodeRow[] {
  const results: Map<string, EpisodeRow> = new Map();

  const fileNames = extractEntitiesForQuery(userInput);
  if (fileNames.length > 0) {
    const placeholders = fileNames.map(() => '?').join(',');
    const rows = db
      .prepare(
        `
      SELECT DISTINCT e.rowid, e.id, e.timestamp, e.project_root, e.user_input,
        e.action_type, e.files_changed, e.success, e.result_summary,
        e.is_summarized, e.step_outputs, e.description, e.keywords, e.tokens_used
      FROM episodes e
      JOIN episode_entities ee ON ee.episode_id = e.id
      JOIN entities en ON en.id = ee.entity_id
      WHERE e.project_root = ? AND en.type = 'file' AND en.name IN (${placeholders})
      ORDER BY e.timestamp DESC
      LIMIT 3
    `,
      )
      .all(projectRoot, ...fileNames) as EpisodeRow[];
    for (const r of rows) results.set(r.id, r);
  }

  const { type, keywords } = detectActionWords(userInput);
  if (type) {
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    const rows = db
      .prepare(
        `
      SELECT rowid, id, timestamp, project_root, user_input,
        action_type, files_changed, success, result_summary,
        is_summarized, step_outputs, description, keywords, tokens_used
      FROM episodes
      WHERE project_root = ? AND action_type = ? AND timestamp > ?
      ORDER BY timestamp DESC
      LIMIT 3
    `,
      )
      .all(projectRoot, type, thirtyDaysAgo) as EpisodeRow[];
    for (const r of rows) results.set(r.id, r);
  }

  if (keywords.length > 0) {
    const query = keywords
      .slice(0, 3)
      .map(
        (k) =>
          `"${k
            .replace(/"/g, '')
            .replace(/\*/g, '')
            .replace(/\^/g, '')
            .replace(/NEAR\([^)]*\)/gi, '')
            .trim()}"`,
      )
      .join(' OR ');
    try {
      const rows = db
        .prepare(
          `
        SELECT e.rowid, e.id, e.timestamp, e.project_root, e.user_input,
          e.action_type, e.files_changed, e.success, e.result_summary,
          e.is_summarized, e.step_outputs, e.description, e.keywords, e.tokens_used
        FROM episodes_fts
        JOIN episodes e ON episodes_fts.rowid = e.rowid
        WHERE episodes_fts MATCH ? AND e.project_root = ?
        ORDER BY rank
        LIMIT 3
      `,
        )
        .all(query, projectRoot) as EpisodeRow[];
      for (const r of rows) results.set(r.id, r);
    } catch {
      /* FTS query failure is non-fatal */
    }
  }

  return [...results.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 5);
}
