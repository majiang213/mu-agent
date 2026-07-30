import Database from 'better-sqlite3';
import { episodeColumns, type EpisodeRow, type SemanticFact } from './types.js';
import { detectActionWords, extractEntitiesForQuery } from './extractor.js';
import { fmtTime, toShortId, parseStructuredSummary } from './episode.js';
import { readSemanticFacts } from './semantic.js';

/**
 * Read side of the memory subsystem: graph retrieval (entity + action_type +
 * FTS5) and the ~200-token index anchor. All episode queries project through
 * the single episodeColumns() list in types.ts.
 */
export function graphRetrieve(userInput: string, db: Database.Database, projectRoot: string): EpisodeRow[] {
  const results: Map<string, EpisodeRow> = new Map();
  const cols = episodeColumns('e');

  const fileNames = extractEntitiesForQuery(userInput);
  if (fileNames.length > 0) {
    const placeholders = fileNames.map(() => '?').join(',');
    const rows = db
      .prepare(
        `
      SELECT DISTINCT ${cols}
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
      SELECT ${cols}
      FROM episodes e
      WHERE e.project_root = ? AND e.action_type = ? AND e.timestamp > ?
      ORDER BY e.timestamp DESC
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
        SELECT ${cols}
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

function fmtTitle(row: EpisodeRow): string {
  const s = parseStructuredSummary(row.result_summary);
  if (s?.action) return s.action.slice(0, 20);
  return row.user_input.slice(0, 20);
}

/** ~200-token memory anchor injected into memory-capable states' prompts (Gap 42). */
export function formatMemoryIndex(db: Database.Database, projectRoot: string): string {
  let rows: EpisodeRow[];
  try {
    rows = db
      .prepare(
        `
      SELECT ${episodeColumns()}
      FROM episodes
      WHERE project_root = ?
      ORDER BY timestamp DESC
      LIMIT 8
    `,
      )
      .all(projectRoot) as EpisodeRow[];
  } catch {
    return '';
  }

  if (rows.length === 0) return '';

  const total = (
    db
      .prepare(
        `
    SELECT COUNT(*) as cnt FROM episodes WHERE project_root = ?
  `,
      )
      .get(projectRoot) as { cnt: number }
  ).cnt;

  const entityRows = db
    .prepare(
      `
    SELECT en.name, COUNT(DISTINCT ee.episode_id) as cnt
    FROM entities en
    JOIN episode_entities ee ON en.id = ee.entity_id
    JOIN episodes e ON ee.episode_id = e.id
    WHERE e.project_root = ? AND en.type = 'file'
    GROUP BY en.id
    HAVING cnt >= 2
    ORDER BY cnt DESC
    LIMIT 5
  `,
    )
    .all(projectRoot) as { name: string; cnt: number }[];

  const facts: SemanticFact[] = readSemanticFacts(db, projectRoot).slice(0, 5);

  const lines: string[] = ['<memory>', '最近任务：'];
  for (const row of rows) {
    const shortId = toShortId(row.id);
    lines.push(`  [${fmtTime(row.timestamp)} #${shortId}] ${fmtTitle(row)}`);
  }
  lines.push(`共 ${total} 条记忆（近30天）`);

  if (entityRows.length > 0) {
    lines.push(`实体：${entityRows.map((e) => `${e.name}(${e.cnt})`).join(' ')}`);
  }

  const prefFacts = facts.filter((f) => f.category === 'preference' || f.category === 'convention');
  if (prefFacts.length > 0) {
    lines.push(`偏好：${prefFacts.map((f) => f.value).join(' | ')}`);
  }

  // NOTE: the memory_search hint line is NOT emitted here — it is spliced in
  // per-state by buildSystemPrompt only for states whose registry entry has
  // memorySearchTool: true (otherwise it advertises a tool the state lacks).
  lines.push('</memory>');
  return lines.join('\n') + '\n';
}
