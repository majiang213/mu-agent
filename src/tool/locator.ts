import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { glob } from 'glob';
import ts from 'typescript';
import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { IGNORE_DIRS } from '../core/graph/constants.js';
import { extractSymbols } from '../core/graph/symbols.js';

export interface ASTSearchResult {
  functionName: string;
  filePath: string;
  location: { startLine: number; endLine: number };
  signature?: string;
  score: number;
  kind: 'function' | 'class' | 'method' | 'arrow';
}

export class ASTLocator {
  async search(params: { query: string; scope?: string; limit?: number }): Promise<ASTSearchResult[]> {
    const { query, scope = '.', limit = 5 } = params;
    const results: ASTSearchResult[] = [];

    const files = await glob('**/*.{ts,tsx,js,jsx}', {
      cwd: scope,
      ignore: [...IGNORE_DIRS].map((d) => `**/${d}/**`),
    });

    for (const file of files.slice(0, 50)) {
      const absolutePath = resolve(scope, file);
      try {
        const fileResults = this.parseFile(absolutePath, file, query);
        results.push(...fileResults);
        if (results.length >= limit * 3) break;
      } catch {
        continue;
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private parseFile(absolutePath: string, relativePath: string, query: string): ASTSearchResult[] {
    let source: string;
    try {
      source = readFileSync(absolutePath, 'utf-8');
    } catch {
      return [];
    }

    const isTS = absolutePath.endsWith('.ts') || absolutePath.endsWith('.tsx');
    const scriptKind = isTS ? ts.ScriptKind.TS : ts.ScriptKind.JS;

    let sourceFile: ts.SourceFile;
    try {
      sourceFile = ts.createSourceFile(absolutePath, source, ts.ScriptTarget.Latest, true, scriptKind);
    } catch {
      return [];
    }

    const results: ASTSearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    // Symbols come from the one shared walker (core/graph/symbols.ts). The
    // locator keeps its own vocabulary on top of the raw records: bare names
    // everywhere, and constructors surface as kind 'method' named
    // 'constructor' (the graph builder's index drops them instead).
    for (const sym of extractSymbols(sourceFile)) {
      // Call sightings (round-5 union extension) are the graph builder's
      // concern, not search results.
      if (sym.kind === 'call') continue;
      if (!this.matches(sym.name, lowerQuery)) continue;
      const kind: ASTSearchResult['kind'] = sym.kind === 'constructor' ? 'method' : sym.kind;
      results.push(this.makeResult(sym.name, relativePath, source, sym.startLine, sym.endLine, kind, query));
    }

    return results;
  }

  private matches(name: string, lowerQuery: string): boolean {
    return name.toLowerCase().includes(lowerQuery);
  }

  private makeResult(
    name: string,
    filePath: string,
    sourceText: string,
    startLine: number,
    endLine: number,
    kind: ASTSearchResult['kind'],
    query: string,
  ): ASTSearchResult {
    const lines = sourceText.split('\n');
    const signature = lines[startLine - 1]?.trim().slice(0, 120);

    return {
      functionName: name,
      filePath,
      location: {
        startLine,
        endLine,
      },
      signature,
      score: this.calculateScore(name, query),
      kind,
    };
  }

  private calculateScore(name: string, query: string): number {
    const lowerName = name.toLowerCase();
    const lowerQuery = query.toLowerCase();
    if (lowerName === lowerQuery) return 1.0;
    if (lowerName.startsWith(lowerQuery)) return 0.8;
    if (lowerName.includes(lowerQuery)) return 0.5;
    return 0.1;
  }
}

const _astLocatorInstance = new ASTLocator();

const _astLocatorParams = Type.Object({
  query: Type.String({ description: 'Symbol name to search for (function, class, method)' }),
  scope: Type.Optional(Type.String({ description: 'Directory to search in (default: current directory)' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum results to return (default: 5)' })),
});

export const astLocatorTool: AgentTool<typeof _astLocatorParams, ASTSearchResult[]> = {
  name: 'ast_code_locator',
  label: 'AST Code Locator',
  description:
    'Find functions, classes, methods, or arrow functions by name using TypeScript AST. Returns file paths and exact line numbers.',
  parameters: _astLocatorParams,
  execute: async (_toolCallId, params) => {
    const results = await _astLocatorInstance.search({
      query: params.query!, // required by the schema (validated upstream of execute)
      scope: params.scope,
      limit: params.limit,
    });
    const text =
      results.length === 0
        ? `No symbols found matching "${params.query}"`
        : results
            .map(
              (r) =>
                `${r.filePath}:${r.location.startLine}-${r.location.endLine} [${r.kind}] ${r.functionName}${r.signature ? ` — ${r.signature}` : ''}`,
            )
            .join('\n');
    return { content: [{ type: 'text' as const, text }], details: results };
  },
};
