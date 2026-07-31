import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { glob } from 'glob';
import ts from 'typescript';
import { GRAPH_DB_DIRNAME, IGNORE_DIRS, getDbPath } from './constants.js';
import { extractSymbols } from './symbols.js';

export interface GraphNode {
  id: number;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  nodeType: 'function' | 'class' | 'method' | 'arrow';
  searchText: string;
  projectRoot: string;
}

function getDb(projectRoot: string): Database.Database {
  const dbPath = getDbPath(projectRoot);
  mkdirSync(join(projectRoot, GRAPH_DB_DIRNAME), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER,
        end_line INTEGER,
        node_type TEXT DEFAULT 'function',
        search_text TEXT,
        project_root TEXT NOT NULL,
        UNIQUE(name, file_path, project_root)
      );
      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id INTEGER NOT NULL REFERENCES nodes(id),
        to_id INTEGER NOT NULL REFERENCES nodes(id),
        edge_type TEXT NOT NULL DEFAULT 'CALLS',
        project_root TEXT NOT NULL,
        UNIQUE(from_id, to_id, edge_type)
      );
      CREATE TABLE IF NOT EXISTS graph_meta (
        project_root TEXT PRIMARY KEY,
        last_built TEXT,
        last_commit TEXT,
        node_count INTEGER,
        edge_count INTEGER,
        build_time_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project_root);
      CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path, project_root);
      CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name, project_root);
      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
    `);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export class GraphBuilder {
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
  }

  needsRebuild(): boolean {
    try {
      const db = getDb(this.projectRoot);
      const meta = db.prepare('SELECT last_commit FROM graph_meta WHERE project_root=?').get(this.projectRoot) as
        { last_commit: string } | undefined;
      db.close();
      if (!meta) return true;
      const currentCommit = this.getCurrentCommit();
      if (!currentCommit) return false;
      return meta.last_commit !== currentCommit;
    } catch {
      return true;
    }
  }

  buildFull(): { nodeCount: number; edgeCount: number; fileCount: number; elapsedMs: number } {
    const t0 = Date.now();
    const db = getDb(this.projectRoot);

    const files = this.collectSourceFiles();
    let nodeCount = 0;
    let edgeCount = 0;

    try {
      const doRebuild = db.transaction(() => {
        db.prepare('DELETE FROM edges WHERE project_root=?').run(this.projectRoot);
        db.prepare('DELETE FROM nodes WHERE project_root=?').run(this.projectRoot);
        for (const file of files) {
          try {
            const [n, e] = this.parseFile(db, file);
            nodeCount += n;
            edgeCount += e;
          } catch {
            continue;
          }
        }
      });
      doRebuild();

      const elapsedMs = Date.now() - t0;
      const currentCommit = this.getCurrentCommit();

      db.prepare(
        `
        INSERT OR REPLACE INTO graph_meta (project_root, last_built, last_commit, node_count, edge_count, build_time_ms)
        VALUES (?, datetime('now'), ?, ?, ?, ?)
      `,
      ).run(this.projectRoot, currentCommit ?? '', nodeCount, edgeCount, elapsedMs);

      return { nodeCount, edgeCount, fileCount: files.length, elapsedMs };
    } finally {
      db.close();
    }
  }

  updateFiles(filePaths: string[]): void {
    // Paths arrive already normalized and containment-checked via
    // resolveProjectPath (step-runner's post-MODIFY update) — the inline
    // re-filter that used to live here resolved against process.cwd() (a
    // weaker duplicate of the check the glossary names as the one home).
    const db = getDb(this.projectRoot);
    try {
      const doUpdate = db.transaction(() => {
        for (const filePath of filePaths) {
          const relPath = relative(this.projectRoot, filePath).replace(/\\/g, '/');
          const oldIds = (
            db.prepare('SELECT id FROM nodes WHERE file_path=? AND project_root=?').all(relPath, this.projectRoot) as {
              id: number;
            }[]
          ).map((r) => r.id);
          if (oldIds.length > 0) {
            const ph = oldIds.map(() => '?').join(',');
            db.prepare(`DELETE FROM edges WHERE (from_id IN (${ph}) OR to_id IN (${ph})) AND project_root=?`).run(
              ...oldIds,
              ...oldIds,
              this.projectRoot,
            );
            db.prepare(`DELETE FROM nodes WHERE id IN (${ph})`).run(...oldIds);
          }
          try {
            this.parseFile(db, filePath);
          } catch {
            continue;
          }
        }
      });
      doUpdate();
    } finally {
      db.close();
    }
  }

  private parseFile(db: Database.Database, filePath: string): [number, number] {
    const relPath = relative(this.projectRoot, filePath).replace(/\\/g, '/');
    let source: string;
    try {
      source = readFileSync(filePath, 'utf-8');
    } catch (err) {
      console.warn('[graph] parseFile error:', err instanceof Error ? err.message : String(err));
      return [0, 0];
    }

    const isTS = filePath.endsWith('.ts') || filePath.endsWith('.tsx');
    const scriptKind = isTS ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    let sourceFile: ts.SourceFile;
    try {
      sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
    } catch (err) {
      console.warn('[graph] parseFile error:', err instanceof Error ? err.message : String(err));
      return [0, 0];
    }

    const insertNode = db.prepare(`
      INSERT OR IGNORE INTO nodes (name, file_path, start_line, end_line, node_type, search_text, project_root)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEdge = db.prepare(`
      INSERT OR IGNORE INTO edges (from_id, to_id, edge_type, project_root)
      VALUES (?, ?, 'CALLS', ?)
    `);
    const getNode = db.prepare('SELECT id FROM nodes WHERE name=? AND file_path=? AND project_root=? LIMIT 1');
    const getNodeByName = db.prepare('SELECT id FROM nodes WHERE name=? AND project_root=? LIMIT 1');

    let nodeCount = 0;
    let edgeCount = 0;

    // Symbols AND call sightings come from the one shared walker
    // (./symbols.ts — extended in round-5 candidate 7; the private second
    // walker that lived here is gone). The graph keeps its own vocabulary on
    // top of the raw records: qualified Class.method names with
    // '<class> <method>' search text, no constructors, and call edges with
    // qualified callers.
    const records = extractSymbols(sourceFile);

    // Phase 1: nodes (all symbol records first — edges may point forward).
    for (const sym of records) {
      if (sym.kind === 'call' || sym.kind === 'constructor') continue;
      const name = sym.kind === 'method' ? `${sym.className}.${sym.name}` : sym.name;
      const searchText = sym.kind === 'method' ? `${sym.className} ${sym.name}` : sym.name;
      insertNode.run(name, relPath, sym.startLine, sym.endLine, sym.kind, searchText, this.projectRoot);
      nodeCount++;
    }

    // Phase 2: call edges from the walker's sightings.
    for (const sym of records) {
      if (sym.kind !== 'call') continue;
      const caller = sym.callerClassName ? `${sym.callerClassName}.${sym.callerName}` : sym.callerName;
      const callerRow = getNode.get(caller, relPath, this.projectRoot) as { id: number } | undefined;
      const calleeRow = getNodeByName.get(sym.callee, this.projectRoot) as { id: number } | undefined;
      if (callerRow && calleeRow && callerRow.id !== calleeRow.id) {
        insertEdge.run(callerRow.id, calleeRow.id, this.projectRoot);
        edgeCount++;
      }
    }

    return [nodeCount, edgeCount];
  }

  private collectSourceFiles(): string[] {
    return glob.sync('**/*.{ts,tsx,js,jsx}', {
      cwd: this.projectRoot,
      ignore: [...IGNORE_DIRS].map((d) => `**/${d}/**`),
      absolute: true,
    });
  }

  private getCurrentCommit(): string | null {
    try {
      return execSync('git rev-parse HEAD', { cwd: this.projectRoot, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      return null;
    }
  }
}

/**
 * Build the project code graph when stale (or when forced). Never throws —
 * entry points degrade gracefully without a graph. ONE implementation for
 * `mu-agent tui`, `mu-agent run`, and the setup wizard (third-pass review,
 * candidate 13).
 */
export function ensureGraphBuilt(
  projectRoot: string,
  options: { force?: boolean } = {},
): { built: boolean; error?: string } {
  try {
    const builder = new GraphBuilder(projectRoot);
    if (options.force === true || builder.needsRebuild()) {
      builder.buildFull();
      return { built: true };
    }
    return { built: false };
  } catch (e) {
    return { built: false, error: e instanceof Error ? e.message : String(e) };
  }
}
