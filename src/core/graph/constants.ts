import { MU_AGENT_DIR } from '../../config/defaults.js';

export const GRAPH_DB_DIRNAME = MU_AGENT_DIR;
export const GRAPH_DB_FILENAME = 'graph.db';

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
