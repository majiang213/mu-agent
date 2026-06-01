import Database from 'better-sqlite3';
import { join, dirname, parse } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

const DB_DIRNAME = '.local-agent';
const DB_FILENAME = 'memory.db';
const CURRENT_SCHEMA_VERSION = 1;

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
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  const version = db.pragma('user_version', { simple: true }) as number;
  if (version < CURRENT_SCHEMA_VERSION) {
    applySchema(db);
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  }
  return db;
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
      is_summarized INTEGER DEFAULT 0,
      step_outputs TEXT,
      description TEXT,
      keywords TEXT,
      tokens_used INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_episodes_project_time ON episodes(project_root, timestamp DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
      user_input UNINDEXED,
      searchable_content,
      content="",
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
      INSERT INTO episodes_fts(rowid, user_input, searchable_content)
      VALUES (
        new.rowid,
        new.user_input,
        new.user_input || ' ' || COALESCE(new.result_summary, '')
      );
    END;

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
