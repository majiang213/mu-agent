import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MU_AGENT_DIR } from '../../config/defaults.js';

export const GRAPH_DB_DIRNAME = MU_AGENT_DIR;
export const GRAPH_DB_FILENAME = 'graph.db';

/** The one graph.db path — shared by the graph builder and retriever. */
export function getDbPath(projectRoot: string): string {
  return join(projectRoot, GRAPH_DB_DIRNAME, GRAPH_DB_FILENAME);
}

/**
 * Whether the code graph has been built for this root. Lives here (not in
 * builder.ts) so callers — e.g. the setup wizard — can ask without loading
 * better-sqlite3, which builder.ts imports eagerly (round-4, candidate 4).
 */
export function graphExists(projectRoot: string): boolean {
  return existsSync(getDbPath(projectRoot));
}

/**
 * THE ignore list — one source for every directory the harness pretends does
 * not exist. Previously three divergent private lists (tree walker ×20,
 * graph builder ×14, AST locator glob ×2) disagreed about project contents
 * (second-pass review, candidate 7).
 */
export const IGNORE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  'tmp',
  'temp',
  '.idea',
  '.vscode',
  'target',
  'vendor',
  'logs',
]);
