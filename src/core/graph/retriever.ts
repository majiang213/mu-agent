import Database from 'better-sqlite3';
import { join, resolve } from 'node:path';
import { GRAPH_DB_DIRNAME, GRAPH_DB_FILENAME } from './constants.js';

function getDbPath(projectRoot: string): string {
  return join(projectRoot, GRAPH_DB_DIRNAME, GRAPH_DB_FILENAME);
}

export interface RetrieveResult {
  id: number;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  nodeType: string;
  bm25Score: number;
}

export class GraphRetriever {
  private bm25Index: Map<number, { tokens: Set<string>; node: RetrieveResult }> | null = null;
  private bm25BuiltAt = 0;
  private projectRoot: string;
  private db: Database.Database | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private getDb(): Database.Database {
    if (!this.db) {
      this.db = new Database(getDbPath(this.projectRoot), { readonly: true });
    }
    return this.db;
  }

  hasGraph(): boolean {
    try {
      const db = this.getDb();
      const meta = db.prepare('SELECT node_count FROM graph_meta WHERE project_root=?').get(this.projectRoot) as
        | { node_count: number }
        | undefined;
      return (meta?.node_count ?? 0) > 0;
    } catch {
      return false;
    }
  }

  retrieve(query: string, maxResults = 10): RetrieveResult[] {
    this.ensureBM25();
    if (!this.bm25Index || this.bm25Index.size === 0) return [];

    const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (queryTokens.length === 0) return [];

    const scores = new Map<number, number>();
    const N = this.bm25Index.size;
    const avgLen = [...this.bm25Index.values()].reduce((s, v) => s + v.tokens.size, 0) / N;
    const k1 = 1.5;
    const b = 0.75;

    const idf = new Map<string, number>();
    for (const token of queryTokens) {
      let df = 0;
      for (const { tokens } of this.bm25Index.values()) {
        if (tokens.has(token)) df++;
      }
      idf.set(token, Math.log((N - df + 0.5) / (df + 0.5) + 1));
    }

    for (const [id, { tokens }] of this.bm25Index) {
      const docLen = tokens.size;
      let score = 0;
      for (const token of queryTokens) {
        const tf = tokens.has(token) ? 1 : 0;
        const idfVal = idf.get(token) ?? 0;
        score += (idfVal * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * docLen) / avgLen));
      }
      if (score > 0) scores.set(id, score);
    }

    const top20 = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([id]) => id);

    if (top20.length === 0) return [];

    const seedIds = new Set(top20);
    const expanded = this.expandGraph(seedIds, 2);
    const allIds = new Set([...seedIds, ...expanded]);

    const results = this.fetchNodes(allIds);
    return results
      .map((n) => ({ ...n, bm25Score: scores.get(n.id) ?? 0 }))
      .sort((a, b) => b.bm25Score - a.bm25Score)
      .slice(0, maxResults);
  }

  private expandGraph(seedIds: Set<number>, hops: number): Set<number> {
    if (seedIds.size === 0) return new Set();
    try {
      const db = this.getDb();
      const discovered = new Set(seedIds);
      let frontier = new Set(seedIds);

      for (let i = 0; i < hops; i++) {
        if (frontier.size === 0) break;
        const ph = [...frontier].map(() => '?').join(',');
        const args = [...frontier, this.projectRoot];

        const toNodes = (
          db.prepare(`SELECT to_id FROM edges WHERE from_id IN (${ph}) AND project_root=?`).all(...args) as {
            to_id: number;
          }[]
        ).map((r) => r.to_id);
        const fromNodes = (
          db.prepare(`SELECT from_id FROM edges WHERE to_id IN (${ph}) AND project_root=?`).all(...args) as {
            from_id: number;
          }[]
        ).map((r) => r.from_id);

        const newNodes = new Set([...toNodes, ...fromNodes].filter((id) => !discovered.has(id)));
        for (const id of newNodes) discovered.add(id);
        frontier = newNodes;
      }

      for (const id of seedIds) discovered.delete(id);
      return discovered;
    } catch {
      return new Set();
    }
  }

  private fetchNodes(ids: Set<number>): RetrieveResult[] {
    if (ids.size === 0) return [];
    try {
      const db = this.getDb();
      const ph = [...ids].map(() => '?').join(',');
      const rows = db
        .prepare(
          `
        SELECT id, name, file_path, start_line, end_line, node_type
        FROM nodes WHERE id IN (${ph}) AND project_root=?
      `,
        )
        .all(...ids, this.projectRoot) as Array<{
        id: number;
        name: string;
        file_path: string;
        start_line: number;
        end_line: number;
        node_type: string;
      }>;
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        filePath: r.file_path,
        startLine: r.start_line,
        endLine: r.end_line,
        nodeType: r.node_type,
        bm25Score: 0,
      }));
    } catch {
      return [];
    }
  }

  private ensureBM25(): void {
    if (this.bm25Index && Date.now() - this.bm25BuiltAt < 300_000) return;
    try {
      const db = this.getDb();
      const rows = db
        .prepare(
          `
        SELECT id, name, file_path, start_line, end_line, node_type, search_text
        FROM nodes WHERE project_root=?
      `,
        )
        .all(this.projectRoot) as Array<{
        id: number;
        name: string;
        file_path: string;
        start_line: number;
        end_line: number;
        node_type: string;
        search_text: string;
      }>;

      this.bm25Index = new Map();
      for (const row of rows) {
        const text = (row.search_text ?? row.name).toLowerCase();
        const tokens = new Set(text.split(/[\s_\-./]+/).filter(Boolean));
        this.bm25Index.set(row.id, {
          tokens,
          node: {
            id: row.id,
            name: row.name,
            filePath: row.file_path,
            startLine: row.start_line,
            endLine: row.end_line,
            nodeType: row.node_type,
            bm25Score: 0,
          },
        });
      }
      this.bm25BuiltAt = Date.now();
    } catch (err) {
      console.warn('[graph] ensureBM25 error:', err instanceof Error ? err.message : String(err));
      this.bm25Index = null;
      this.bm25BuiltAt = 0;
    }
  }
}
