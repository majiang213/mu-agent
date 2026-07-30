import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { removeStopwords } from 'stopword';
import { IGNORE_DIRS } from './constants.js';

const MAX_DEPTH = 3;
const MAX_FILES = 200;
const MAX_CHARS = 3000;

/**
 * One structured walk of the project tree. Previously the filesystem was
 * serialized to an indented display string and then RE-PARSED back into
 * paths (indent÷2 arithmetic) — a representation round-trip through a
 * human-readable format that also made the 3000-char display cap silently
 * shrink the retrieval candidate set (second-pass review, candidate 7).
 */
export interface TreeEntry {
  /** Project-relative path (forward slashes). */
  path: string;
  isDir: boolean;
  depth: number;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Walk the project once into structured entries (depth-capped, file-capped). */
export function scanProjectTree(cwd: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let fileCount = 0;
  let truncated = false;

  function scan(dir: string, depth: number): void {
    if (depth > MAX_DEPTH || truncated) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    const dirs = names.filter((e) => !e.startsWith('.') && !IGNORE_DIRS.has(e) && isDir(join(dir, e)));
    const files = names.filter((e) => !e.startsWith('.') && !IGNORE_DIRS.has(e) && isFile(join(dir, e)));

    for (const f of files) {
      if (fileCount >= MAX_FILES) {
        truncated = true;
        return;
      }
      entries.push({ path: relative(cwd, join(dir, f)).split('\\').join('/'), isDir: false, depth });
      fileCount++;
    }
    for (const d of dirs) {
      entries.push({ path: relative(cwd, join(dir, d)).split('\\').join('/'), isDir: true, depth });
      scan(join(dir, d), depth + 1);
    }
  }

  scan(cwd, 0);
  return entries;
}

/** Render the display string for the model prompt (presentation-only cap). */
export function renderProjectTree(entries: TreeEntry[]): string {
  const lines = entries.map(
    (e) => `${'  '.repeat(e.depth)}${e.isDir ? `${e.path.split('/').pop()}/` : e.path.split('/').pop()}`,
  );
  // Directory lines must reconstruct the indent-relative layout the model
  // expects: name at its depth. (Entries carry full paths; display shows
  // basename at depth, matching the historical format.)
  const result = lines.join('\n');
  if (result.length <= MAX_CHARS) return result;
  // Truncate at the last newline boundary before MAX_CHARS to avoid cutting file names
  const sliced = result.slice(0, MAX_CHARS);
  const lastNewline = sliced.lastIndexOf('\n');
  return (lastNewline > 0 ? sliced.slice(0, lastNewline) : sliced) + '\n...';
}

const ZH_STOP_WORDS = new Set([
  '的',
  '在',
  '找',
  '读',
  '看',
  '理解',
  '分析',
  '修改',
  '当前',
  '代码',
  '文件',
  '函数',
  '方法',
  '类',
  '模块',
  '实现',
  '功能',
]);

const ENTRY_PATTERNS = ['agent.ts', 'index.ts', 'cli.ts', 'main.ts', 'app.ts', 'server.ts'];

/**
 * Fallback candidate extraction (keyword path). Operates on the FULL
 * structured walk — the display cap no longer shrinks the candidate set.
 */
export function extractCandidateFiles(entries: TreeEntry[], focus: string): string[] {
  const allFiles = entries.filter((e) => !e.isDir).map((e) => e.path);

  const rawWords = focus
    .toLowerCase()
    .split(/[\s\-_./,，。：:()（）[\]{}]+/)
    .filter((w) => w.length > 2 && !ZH_STOP_WORDS.has(w));
  const keywords = removeStopwords(rawWords);
  if (keywords.length === 0) {
    return allFiles.filter((f) => ENTRY_PATTERNS.some((p) => f.endsWith(p))).slice(0, 5);
  }

  return allFiles.filter((f) => keywords.some((kw) => f.toLowerCase().includes(kw))).slice(0, 5);
}
