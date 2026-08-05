import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { EpisodeRow, StructuredSummary } from './types.js';
import type { ExecutedStep, StateResult } from '../types.js';
import type { Mission } from '../agent/types.js';
import { buildStructuredSummary, extractEntitiesForWrite } from './extractor.js';
import { nowSeconds } from './db.js';
import { updateSemanticFacts } from './semantic.js';

/**
 * THE searchable-content recipe (round-5, candidate 2) — ONE HOME for what
 * text makes an episode findable. Used by both write paths:
 * - writeEpisodeSync: structured fields available at insert time
 *   (key_finding + files — no LLM fields yet);
 * - applyEpisodeSummary (summarizer.ts): re-indexes with the LLM's
 *   description + keywords added, via the SAME function.
 * Previously the insert trigger indexed raw result_summary JSON while the
 * summarizer rebuilt a different recipe — search results drifted depending
 * on whether the debounced summarizer had run.
 */
export function buildSearchableContent(
  userInput: string,
  structured?: { key_finding?: string | null; files?: string[] } | null,
  llm?: { description?: string; keywords?: string[] } | null,
): string {
  return [
    userInput,
    llm?.description ?? '',
    ...(llm?.keywords ?? []),
    structured?.key_finding ?? '',
    ...(structured?.files ?? []),
  ]
    .filter((s) => s.length > 0)
    .join(' ');
}

export function writeEpisodeSync(
  db: Database.Database,
  mission: Mission,
  allStepResults: ExecutedStep[],
  finalResult: StateResult,
  projectRoot: string,
): string {
  const episodeId = randomUUID();
  const structuredSummary = buildStructuredSummary(allStepResults, finalResult, mission.description);
  const actionType = structuredSummary.action;
  const resultSummary = JSON.stringify(structuredSummary);
  const filesChanged = structuredSummary.files;

  const stepOutputs = allStepResults.map((s) => ({
    state: s.state,
    focus: s.focus,
    output: s.output.slice(0, 4096),
  }));

  const entities = extractEntitiesForWrite(mission.description, structuredSummary);

  db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare(
        `
      INSERT INTO episodes (id, timestamp, project_root, user_input, action_type,
        files_changed, success, result_summary, step_outputs)
      VALUES (?,?,?,?,?,?,?,?,?)
    `,
      )
      .run(
        episodeId,
        nowSeconds(),
        projectRoot,
        mission.description,
        actionType,
        JSON.stringify(filesChanged),
        finalResult.success ? 1 : 0,
        resultSummary,
        JSON.stringify(stepOutputs),
      );

    // FTS row written explicitly with THE recipe (buildSearchableContent) —
    // the old insert trigger indexed raw result_summary JSON instead
    // (round-5, candidate 2). Summarization later rewrites this row with the
    // same recipe plus LLM fields.
    db.prepare(`INSERT INTO episodes_fts(rowid, user_input, searchable_content) VALUES(?,?,?)`).run(
      lastInsertRowid,
      mission.description,
      buildSearchableContent(mission.description, structuredSummary),
    );

    db.prepare(
      `
      INSERT INTO pending_summaries (episode_id, created_at) VALUES (?, ?)
    `,
    ).run(episodeId, nowSeconds());

    for (const entity of entities) {
      // INSERT OR IGNORE: if entity already exists the provided entityId is discarded.
      // Always SELECT after to get the actual persisted id.
      const newEntityId = randomUUID();
      db.prepare(`INSERT OR IGNORE INTO entities (id, project_root, type, name) VALUES (?,?,?,?)`).run(
        newEntityId,
        projectRoot,
        entity.type,
        entity.name,
      );
      const existing = db
        .prepare(`SELECT id FROM entities WHERE project_root=? AND type=? AND name=?`)
        .get(projectRoot, entity.type, entity.name) as { id: string } | undefined;
      if (existing) {
        db.prepare(`INSERT OR IGNORE INTO episode_entities (episode_id, entity_id, role) VALUES (?,?,?)`).run(
          episodeId,
          existing.id,
          entity.role,
        );
      }
    }

    updateSemanticFacts(db, mission.description, projectRoot);
  })();

  return episodeId;
}

export function toShortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 4);
}

export function parseStructuredSummary(json: string): StructuredSummary | null {
  try {
    return JSON.parse(json) as StructuredSummary;
  } catch {
    return null;
  }
}

export function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatEpisodeDetail(ep: EpisodeRow): string {
  const trunc = (s: string | null | undefined, max = 400): string =>
    !s ? '' : s.length <= max ? s : s.slice(0, max) + '…';
  const s = parseStructuredSummary(ep.result_summary);
  const time = fmtTime(ep.timestamp);
  const shortId = toShortId(ep.id);

  const lines = [`[${time} #${shortId}] ${trunc(ep.user_input)}`];
  if (s?.action) lines.push(`Action: ${s.action}`);
  if (s?.files?.length) lines.push(`Files: ${s.files.join(', ')}`);
  if (s?.key_finding) lines.push(`Finding: ${trunc(s.key_finding)}`);
  if (s?.error_summary) lines.push(`Error: ${trunc(s.error_summary)}`);
  const outcome = ep.success ? 'success' : 'failed';
  lines.push(`Result: ${outcome}`);
  return lines.join('\n');
}
