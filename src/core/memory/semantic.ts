import Database from 'better-sqlite3';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SemanticFact, EpisodeRecord } from './types.js';

export function readSemanticFacts(db: Database.Database, projectRoot: string): SemanticFact[] {
  return db
    .prepare(
      `
    SELECT id, project_root, category, key, value, confidence, last_seen, source
    FROM semantic_facts
    WHERE project_root = ?
    ORDER BY confidence DESC
    LIMIT 20
  `,
    )
    .all(projectRoot) as SemanticFact[];
}

export function updateSemanticFacts(db: Database.Database, episode: EpisodeRecord, projectRoot: string): void {
  const upsertFact = (category: string, key: string, value: string, source: 'inferred' | 'explicit') => {
    db.prepare(
      `
      INSERT INTO semantic_facts (id, project_root, category, key, value, confidence, last_seen, source)
      VALUES (?,?,?,?,?,1.0,?,?)
      ON CONFLICT(project_root, category, key, value)
      DO UPDATE SET confidence = MIN(confidence + 0.1, 1.0), last_seen = excluded.last_seen
    `,
    ).run(randomUUID(), projectRoot, category, key, value, Math.floor(Date.now() / 1000), source);
  };

  if (/中文|chinese|用中文/i.test(episode.userInput)) upsertFact('preference', 'language', 'zh', 'explicit');
  if (/英文|english|用英文/i.test(episode.userInput)) upsertFact('preference', 'language', 'en', 'explicit');

  if (episode.verifyCommands?.some((c) => c.includes('vitest')))
    upsertFact('convention', 'test_command', 'npx vitest run', 'inferred');
  if (episode.verifyCommands?.some((c) => c.includes('mvn test')))
    upsertFact('convention', 'test_command', 'mvn test', 'inferred');
  if (episode.verifyCommands?.some((c) => c.includes('pytest')))
    upsertFact('convention', 'test_command', 'pytest', 'inferred');

  const allFilesChanged = db
    .prepare(
      `
    SELECT files_changed FROM episodes
    WHERE project_root = ? AND files_changed IS NOT NULL
  `,
    )
    .all(projectRoot) as { files_changed: string }[];

  const fileCounts: Record<string, number> = {};
  for (const row of allFilesChanged) {
    try {
      const files = JSON.parse(row.files_changed) as string[];
      for (const f of files) {
        fileCounts[f] = (fileCounts[f] ?? 0) + 1;
      }
    } catch {
      /* skip */
    }
  }
  for (const [file, count] of Object.entries(fileCounts)) {
    if (count >= 3) upsertFact('hot_file', 'path', basename(file), 'inferred');
  }
}

export function decaySemanticFacts(db: Database.Database, projectRoot: string): void {
  const lastDecay = db.prepare(`SELECT value FROM meta WHERE key = 'last_decay_at'`).get() as
    { value: string } | undefined;

  if (lastDecay) {
    const elapsed = Math.floor(Date.now() / 1000) - parseInt(lastDecay.value, 10);
    if (elapsed < 24 * 3600) return;
  }

  db.prepare(
    `
    UPDATE semantic_facts
    SET confidence = confidence - 0.05
    WHERE last_seen < strftime('%s','now','-90 days')
      AND project_root = ?
      AND source = 'inferred'
  `,
  ).run(projectRoot);

  db.prepare(
    `
    DELETE FROM semantic_facts
    WHERE confidence < 0.2
      AND project_root = ?
      AND source = 'inferred'
  `,
  ).run(projectRoot);

  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('last_decay_at', ?)`).run(
    Math.floor(Date.now() / 1000).toString(),
  );
}
