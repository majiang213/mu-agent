import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { glob } from 'glob';
import ts from 'typescript';

const DB_DIRNAME = '.mu-agent';
const DB_FILENAME = 'graph.db';

function getDbPath(projectRoot: string): string {
  return join(projectRoot, DB_DIRNAME, DB_FILENAME);
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '__pycache__',
  '.venv',
  'venv',
  'coverage',
  '.next',
  '.nuxt',
  'target',
  'vendor',
]);

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
  mkdirSync(join(projectRoot, DB_DIRNAME), { recursive: true });
  const db = new Database(dbPath);
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
        | { last_commit: string }
        | undefined;
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

    db.prepare('DELETE FROM edges WHERE project_root=?').run(this.projectRoot);
    db.prepare('DELETE FROM nodes WHERE project_root=?').run(this.projectRoot);

    const files = this.collectSourceFiles();
    let nodeCount = 0;
    let edgeCount = 0;

    for (const file of files) {
      try {
        const [n, e] = this.parseFile(db, file);
        nodeCount += n;
        edgeCount += e;
      } catch {
        continue;
      }
    }

    const elapsedMs = Date.now() - t0;
    const currentCommit = this.getCurrentCommit();

    db.prepare(
      `
      INSERT OR REPLACE INTO graph_meta (project_root, last_built, last_commit, node_count, edge_count, build_time_ms)
      VALUES (?, datetime('now'), ?, ?, ?, ?)
    `,
    ).run(this.projectRoot, currentCommit ?? '', nodeCount, edgeCount, elapsedMs);

    db.close();
    return { nodeCount, edgeCount, fileCount: files.length, elapsedMs };
  }

  updateFiles(filePaths: string[]): void {
    const db = getDb(this.projectRoot);
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
    db.close();
  }

  private parseFile(db: Database.Database, filePath: string): [number, number] {
    const relPath = relative(this.projectRoot, filePath).replace(/\\/g, '/');
    let source: string;
    try {
      source = readFileSync(filePath, 'utf-8');
    } catch {
      return [0, 0];
    }

    const isTS = filePath.endsWith('.ts') || filePath.endsWith('.tsx');
    const scriptKind = isTS ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    let sourceFile: ts.SourceFile;
    try {
      sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
    } catch {
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

    const getLineNumber = (node: ts.Node): number => {
      return sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    };
    const getEndLine = (node: ts.Node): number => {
      return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    };

    const functionNames = new Map<ts.Node, string>();

    const extractFunctions = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const name = node.name.text;
        functionNames.set(node, name);
        insertNode.run(name, relPath, getLineNumber(node), getEndLine(node), 'function', name, this.projectRoot);
        nodeCount++;
      } else if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        insertNode.run(className, relPath, getLineNumber(node), getEndLine(node), 'class', className, this.projectRoot);
        nodeCount++;
        ts.forEachChild(node, (child) => {
          if (ts.isMethodDeclaration(child) && ts.isIdentifier(child.name)) {
            const methodName = child.name.text;
            const qualName = `${className}.${methodName}`;
            functionNames.set(child, qualName);
            insertNode.run(
              qualName,
              relPath,
              getLineNumber(child),
              getEndLine(child),
              'method',
              `${className} ${methodName}`,
              this.projectRoot,
            );
            nodeCount++;
          }
        });
      } else if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) &&
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
          ) {
            const name = decl.name.text;
            functionNames.set(node, name);
            insertNode.run(name, relPath, getLineNumber(node), getEndLine(node), 'arrow', name, this.projectRoot);
            nodeCount++;
          }
        }
      }
      ts.forEachChild(node, extractFunctions);
    };

    ts.forEachChild(sourceFile, extractFunctions);

    const extractCalls = (node: ts.Node, enclosingFn: string | null): void => {
      let currentFn = enclosingFn;
      if (ts.isFunctionDeclaration(node) && node.name) currentFn = node.name.text;
      else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        const parent = node.parent;
        const className = ts.isClassDeclaration(parent) && parent.name ? parent.name.text : '';
        currentFn = className ? `${className}.${node.name.text}` : node.name.text;
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        currentFn = node.name.text;
      }

      if (ts.isCallExpression(node) && currentFn) {
        let calleeName: string | null = null;
        if (ts.isIdentifier(node.expression)) {
          calleeName = node.expression.text;
        } else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)) {
          calleeName = node.expression.name.text;
        }
        if (calleeName) {
          const callerRow = getNode.get(currentFn, relPath, this.projectRoot) as { id: number } | undefined;
          const calleeRow = getNodeByName.get(calleeName, this.projectRoot) as { id: number } | undefined;
          if (callerRow && calleeRow && callerRow.id !== calleeRow.id) {
            insertEdge.run(callerRow.id, calleeRow.id, this.projectRoot);
            edgeCount++;
          }
        }
      }

      ts.forEachChild(node, (child) => extractCalls(child, currentFn));
    };

    ts.forEachChild(sourceFile, (child) => extractCalls(child, null));

    return [nodeCount, edgeCount];
  }

  private collectSourceFiles(): string[] {
    return glob.sync('**/*.{ts,tsx,js,jsx}', {
      cwd: this.projectRoot,
      ignore: [...SKIP_DIRS].map((d) => `**/${d}/**`),
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
