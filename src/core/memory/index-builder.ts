import Database from 'better-sqlite3';
import type { EpisodeRow, StructuredSummary, SemanticFact } from './types.js';
import { fmtTime } from './episode.js';
import { readSemanticFacts } from './semantic.js';

function fmtTitle(row: EpisodeRow): string {
  try {
    const s = JSON.parse(row.result_summary) as StructuredSummary;
    if (s.action) return s.action.slice(0, 20);
  } catch {
    /* fallback */
  }
  return row.user_input.slice(0, 20);
}

export function formatMemoryIndex(db: Database.Database, projectRoot: string): string {
  let rows: EpisodeRow[];
  try {
    rows = db
      .prepare(
        `
      SELECT rowid, id, user_input, result_summary, action_type, files_changed, success, timestamp,
        is_summarized, step_outputs, description, keywords, tokens_used, project_root
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
    const shortId = row.id.replace(/-/g, '').slice(0, 4);
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

  lines.push('使用 memory_search 工具可查看任意条目的详情。');
  lines.push('</memory>');
  return lines.join('\n') + '\n';
}
