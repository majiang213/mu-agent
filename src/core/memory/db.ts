import Database from 'better-sqlite3';
import { join, dirname, parse } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { MU_AGENT_DIR } from '../../config/defaults.js';

const DB_DIRNAME = MU_AGENT_DIR;
const DB_FILENAME = 'memory.db';
const CURRENT_SCHEMA_VERSION = 2;

/**
 * v1 → v2: drop the dead columns (is_summarized, tokens_used) — write-only,
 * zero readers (round-5 hygiene). Pending state lives in pending_summaries.
 * Idempotent via PRAGMA table_info (a fresh v2 DB has neither column).
 */
function migrateV2(db: Database.Database): void {
  const cols = db.pragma('table_info(episodes)') as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (names.has('is_summarized')) db.exec('ALTER TABLE episodes DROP COLUMN is_summarized');
  if (names.has('tokens_used')) db.exec('ALTER TABLE episodes DROP COLUMN tokens_used');
}

export function findGitRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== parse(dir).root) {
    if (existsSync(join(dir, '.git'))) return dir;
    dir = dirname(dir);
  }
  return startDir;
}

export function initMemoryDb(gitRoot: string): Database.Database {
  const dbDir = join(gitRoot, DB_DIRNAME);
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, DB_FILENAME);
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');

    const version = db.pragma('user_version', { simple: true }) as number;
    if (version < CURRENT_SCHEMA_VERSION) {
      applySchema(db);
      migrateV2(db);
      db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    }
    // Retire the v1 insert trigger on every open (idempotent): FTS rows are
    // now written explicitly with the one recipe in episode.ts — the trigger
    // indexed raw result_summary JSON, a divergent second recipe (round-5).
    db.exec('DROP TRIGGER IF EXISTS episodes_ai');
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      /* best-effort cleanup */
    }
    throw new Error('[MemoryStore] SQLite init failed: ' + (err instanceof Error ? err.message : String(err)), {
      cause: err,
    });
  }
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      project_root TEXT NOT NULL,
      user_input TEXT NOT NULL,
      action_type TEXT NOT NULL,
      files_changed TEXT,
      success INTEGER NOT NULL,
      result_summary TEXT NOT NULL,
      step_outputs TEXT,
      description TEXT,
      keywords TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_episodes_project_time ON episodes(project_root, timestamp DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
      user_input UNINDEXED,
      searchable_content,
      content="",
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
      INSERT INTO episodes_fts(episodes_fts, rowid) VALUES('delete', old.rowid);
    END;

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      project_root TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entity ON entities(project_root, type, name);

    CREATE TABLE IF NOT EXISTS episode_entities (
      episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      role TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ep_entity ON episode_entities(entity_id, episode_id);

    CREATE TABLE IF NOT EXISTS semantic_facts (
      id TEXT PRIMARY KEY,
      project_root TEXT NOT NULL,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      last_seen INTEGER NOT NULL,
      source TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_semantic ON semantic_facts(project_root, category, key, value);

    CREATE TABLE IF NOT EXISTS pending_summaries (
      episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

/** Unix seconds — the one clock read for all memory tables (was 7 inline copies). */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Seconds since the meta key was last touched, or null when never. The
 * debounce protocol (read meta → elapsed guard → work → touch) is shared by
 * semantic-fact decay (24h) and summary processing (60s) — round-8, C9.
 */
export function metaElapsedSeconds(db: Database.Database, key: string): number | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return null;
  return nowSeconds() - parseInt(row.value, 10);
}

export function touchMeta(db: Database.Database, key: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, nowSeconds().toString());
}
