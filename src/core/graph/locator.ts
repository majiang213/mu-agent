import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GraphBuilder } from './builder.js';
import { GraphRetriever } from './retriever.js';
import { buildProjectTree, extractCandidateFiles } from './tree.js';

export interface LocateResult {
  files: string[];
  snippets: Record<string, string>;
  tree: string;
  suggestedFiles: Array<{ path: string; hint?: string }>;
  method: 'bm25_graph' | 'keyword';
}

export class CodeGraphLocator {
  private builder: GraphBuilder;
  private retriever: GraphRetriever;
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
    this.builder = new GraphBuilder(this.projectRoot);
    this.retriever = new GraphRetriever(this.projectRoot);
  }

  locate(focus: string): LocateResult {
    const tree = buildProjectTree(this.projectRoot);

    if (this.retriever.hasGraph()) {
      const results = this.retriever.retrieve(focus);
      if (results.length > 0) {
        const files = [...new Set(results.map((r) => r.filePath))];
        const snippets = this.readSnippets(results);
        const seenPaths = new Set<string>();
        const suggestedFiles: Array<{ path: string; hint?: string }> = [];
        for (const r of results) {
          if (!seenPaths.has(r.filePath)) {
            seenPaths.add(r.filePath);
            suggestedFiles.push({ path: r.filePath, hint: `${r.name} (line ${r.startLine})` });
          }
          if (suggestedFiles.length >= 5) break;
        }
        return { files, snippets, tree, suggestedFiles, method: 'bm25_graph' };
      }
    }

    const candidates = extractCandidateFiles(tree, focus);
    const suggestedFiles = candidates.map((p) => ({ path: p }));
    return { files: candidates, snippets: {}, tree, suggestedFiles, method: 'keyword' };
  }

  buildGraph(): void {
    this.builder.buildFull();
  }

  needsRebuild(): boolean {
    return this.builder.needsRebuild();
  }

  updateFiles(filePaths: string[]): void {
    this.builder.updateFiles(filePaths);
    this.retriever = new GraphRetriever(this.projectRoot);
  }

  private readSnippets(
    results: Array<{ filePath: string; startLine: number; endLine: number }>,
  ): Record<string, string> {
    const snippets: Record<string, string> = {};
    const byFile = new Map<string, Array<{ startLine: number; endLine: number }>>();

    for (const r of results) {
      if (!byFile.has(r.filePath)) byFile.set(r.filePath, []);
      byFile.get(r.filePath)!.push({ startLine: r.startLine, endLine: r.endLine });
    }

    for (const [filePath, ranges] of byFile) {
      const absPath = join(this.projectRoot, filePath);
      try {
        const lines = readFileSync(absPath, 'utf-8').split('\n');
        const parts: string[] = [];
        for (const { startLine, endLine } of ranges.slice(0, 2)) {
          const start = Math.max(0, startLine - 1);
          const end = Math.min(lines.length, endLine + 2);
          parts.push(lines.slice(start, end).join('\n'));
        }
        snippets[filePath] = parts.join('\n...\n');
      } catch {
        continue;
      }
    }

    return snippets;
  }
}
