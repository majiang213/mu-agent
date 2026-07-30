import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { EpisodeRow, EpisodeRecord, StructuredSummary } from './types.js';
import type { ExecutedStep, StateResult } from '../types.js';
import type { Mission } from '../agent/types.js';
import { buildStructuredSummary, extractEntitiesForWrite } from './extractor.js';
import { updateSemanticFacts } from './semantic.js';

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
  const filesChanged = structuredSummary.files ?? [];

  const stepOutputs = allStepResults.map((s) => ({
    state: s.state,
    focus: s.focus,
    output: s.output.slice(0, 4096),
  }));

  const entities = extractEntitiesForWrite(mission.description, allStepResults, structuredSummary);

  const episodeRecord: EpisodeRecord = {
    userInput: mission.description,
  };

  db.transaction(() => {
    db.prepare(
      `
      INSERT INTO episodes (id, timestamp, project_root, user_input, action_type,
        files_changed, success, result_summary, is_summarized, step_outputs, tokens_used)
      VALUES (?,?,?,?,?,?,?,?,0,?,?)
    `,
    ).run(
      episodeId,
      Math.floor(Date.now() / 1000),
      projectRoot,
      mission.description,
      actionType,
      JSON.stringify(filesChanged),
      finalResult.success ? 1 : 0,
      resultSummary,
      JSON.stringify(stepOutputs),
      0,
    );

    db.prepare(
      `
      INSERT INTO pending_summaries (episode_id, created_at) VALUES (?, ?)
    `,
    ).run(episodeId, Math.floor(Date.now() / 1000));

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

    updateSemanticFacts(db, episodeRecord, projectRoot);
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
  if (s?.action) lines.push(`动作：${s.action}`);
  if (s?.files?.length) lines.push(`文件：${s.files.join(', ')}`);
  if (s?.key_finding) lines.push(`结论：${trunc(s.key_finding)}`);
  if (s?.error_summary) lines.push(`失败：${trunc(s.error_summary)}`);
  const outcome = ep.success ? 'success' : 'failed';
  lines.push(`结果：${outcome}`);
  return lines.join('\n');
}
