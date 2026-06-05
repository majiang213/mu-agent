import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { EpisodeRow, EpisodeRecord, StructuredSummary } from './types.js';
import type { ExecutedStep, StateResult, Mission } from './types.js';
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
    verifyCommands: [],
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
      const entityId = randomUUID();
      db.prepare(
        `
        INSERT OR IGNORE INTO entities (id, project_root, type, name) VALUES (?,?,?,?)
      `,
      ).run(entityId, projectRoot, entity.type, entity.name);
      const existing = db
        .prepare(`SELECT id FROM entities WHERE project_root=? AND type=? AND name=?`)
        .get(projectRoot, entity.type, entity.name) as { id: string } | undefined;
      if (existing) {
        db.prepare(
          `
          INSERT OR IGNORE INTO episode_entities (episode_id, entity_id, role) VALUES (?,?,?)
        `,
        ).run(episodeId, existing.id, entity.role);
      }
    }

    updateSemanticFacts(db, episodeRecord, projectRoot);
  })();

  return episodeId;
}

export function formatEpisodeForInjection(ep: EpisodeRow): string {
  let s: StructuredSummary;
  try {
    const parsed = JSON.parse(ep.result_summary) as unknown;
    if (typeof parsed !== 'object' || parsed === null || !('action' in parsed)) {
      return `[旧格式] ${ep.user_input.slice(0, 60)} → ${ep.result_summary.slice(0, 100)}`;
    }
    s = parsed as StructuredSummary;
  } catch {
    return `[旧格式] ${ep.user_input.slice(0, 60)} → ${ep.result_summary.slice(0, 100)}`;
  }
  const parts: string[] = [];
  if (s.files && s.files.length > 0) {
    const fileStr = s.files.slice(0, 3).join(', ') + (s.files.length > 3 ? `等${s.files.length}个文件` : '');
    parts.push(`修改了 ${fileStr}`);
  }
  if (s.verify_passed === true) parts.push('测试通过');
  else if (s.verify_passed === false) parts.push('测试失败');
  if (s.key_finding) parts.push(s.key_finding);
  if (s.error_summary) parts.push(`失败：${s.error_summary}`);
  const outcome = ep.success ? 'success' : 'failed';
  parts.push(`结果：${outcome}`);
  return parts.join('，');
}

export function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatEpisodeDetail(ep: EpisodeRow): string {
  const trunc = (s: string | null | undefined, max = 400): string =>
    !s ? '' : s.length <= max ? s : s.slice(0, max) + '…';
  const s = (() => {
    try {
      return JSON.parse(ep.result_summary) as StructuredSummary;
    } catch {
      return null;
    }
  })();
  const time = fmtTime(ep.timestamp);
  const shortId = ep.id.replace(/-/g, '').slice(0, 4);

  const lines = [`[${time} #${shortId}] ${trunc(ep.user_input)}`];
  if (s?.action) lines.push(`动作：${s.action}`);
  if (s?.files?.length) lines.push(`文件：${s.files.join(', ')}`);
  if (s?.key_finding) lines.push(`结论：${trunc(s.key_finding)}`);
  if (s?.error_summary) lines.push(`失败：${trunc(s.error_summary)}`);
  const outcome = ep.success ? 'success' : 'failed';
  lines.push(`结果：${outcome}`);
  return lines.join('\n');
}

export function readRecentEpisodes(db: Database.Database, projectRoot: string, limit = 8): EpisodeRow[] {
  return db
    .prepare(
      `
    SELECT rowid, id, user_input, result_summary, action_type, files_changed, success, timestamp,
      is_summarized, step_outputs, description, keywords, tokens_used, project_root
    FROM episodes
    WHERE project_root = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `,
    )
    .all(projectRoot, limit) as EpisodeRow[];
}
