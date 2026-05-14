import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const IGNORE_DIRS = new Set([
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

const MAX_DEPTH = 3;
const MAX_FILES = 200;
const MAX_CHARS = 3000;

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

export function buildProjectTree(cwd: string): string {
  const lines: string[] = [];
  let fileCount = 0;
  let truncated = false;

  function scan(dir: string, depth: number, indent: string): void {
    if (depth > MAX_DEPTH || truncated) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }

    const dirs = entries.filter((e) => !e.startsWith('.') && !IGNORE_DIRS.has(e) && isDir(join(dir, e)));
    const files = entries.filter((e) => !IGNORE_DIRS.has(e) && isFile(join(dir, e)));

    for (const f of files) {
      if (fileCount >= MAX_FILES) {
        truncated = true;
        return;
      }
      lines.push(`${indent}${f}`);
      fileCount++;
    }
    for (const d of dirs) {
      lines.push(`${indent}${d}/`);
      scan(join(dir, d), depth + 1, indent + '  ');
    }
  }

  scan(cwd, 0, '');
  if (truncated) lines.push('... (truncated)');

  const result = lines.join('\n');
  return result.length > MAX_CHARS ? result.slice(0, MAX_CHARS) + '\n...' : result;
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'in',
  'for',
  'to',
  'of',
  'and',
  'or',
  'is',
  'are',
  'was',
  'find',
  'get',
  'read',
  'look',
  'check',
  'show',
  'list',
  'all',
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

function parseTreeFiles(tree: string): string[] {
  const files: string[] = [];
  const pathStack: string[] = [];

  for (const line of tree.split('\n')) {
    if (!line.trim() || line.startsWith('...')) continue;
    const indent = line.length - line.trimStart().length;
    const name = line.trim();
    const depth = Math.floor(indent / 2);

    if (name.endsWith('/')) {
      pathStack.splice(depth);
      pathStack.push(name.slice(0, -1));
    } else {
      const dirPath = pathStack.slice(0, depth).join('/');
      files.push(dirPath ? `${dirPath}/${name}` : name);
    }
  }
  return files;
}

export function extractCandidateFiles(tree: string, focus: string): string[] {
  const allFiles = parseTreeFiles(tree);

  const keywords = focus
    .toLowerCase()
    .split(/[\s\-_./,，。：:()（）[\]{}]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  if (keywords.length === 0) {
    return allFiles.filter((f) => ENTRY_PATTERNS.some((p) => f.endsWith(p))).slice(0, 5);
  }

  return allFiles.filter((f) => keywords.some((kw) => f.toLowerCase().includes(kw))).slice(0, 5);
}
