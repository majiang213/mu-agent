import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { glob } from 'glob';
import ts from 'typescript';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';

export interface ASTSearchResult {
  functionName: string;
  filePath: string;
  location: { startLine: number; endLine: number };
  signature?: string;
  score: number;
  kind: 'function' | 'class' | 'method' | 'arrow';
}

export function createASTLocator(): ASTLocator {
  return new ASTLocator();
}

export class ASTLocator {
  async search(params: {
    query: string;
    scope?: string;
    limit?: number;
  }): Promise<ASTSearchResult[]> {
    const { query, scope = '.', limit = 5 } = params;
    const results: ASTSearchResult[] = [];

    const files = await glob('**/*.{ts,tsx,js,jsx}', {
      cwd: scope,
      ignore: ['node_modules/**', 'dist/**'],
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

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
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
      sourceFile = ts.createSourceFile(
        absolutePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        scriptKind,
      );
    } catch {
      return [];
    }

    const results: ASTSearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const name = node.name.text;
        if (this.matches(name, lowerQuery)) {
          results.push(this.makeResult(name, relativePath, sourceFile, node, 'function', query));
        }
      } else if (ts.isClassDeclaration(node) && node.name) {
        const name = node.name.text;
        if (this.matches(name, lowerQuery)) {
          results.push(this.makeResult(name, relativePath, sourceFile, node, 'class', query));
        }
        ts.forEachChild(node, (child) => {
          if (ts.isMethodDeclaration(child) || ts.isConstructorDeclaration(child)) {
            const methodName = ts.isConstructorDeclaration(child)
              ? 'constructor'
              : ts.isIdentifier((child as ts.MethodDeclaration).name)
                ? ((child as ts.MethodDeclaration).name as ts.Identifier).text
                : '';
            if (methodName && this.matches(methodName, lowerQuery)) {
              results.push(this.makeResult(methodName, relativePath, sourceFile, child, 'method', query));
            }
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
            if (this.matches(name, lowerQuery)) {
              results.push(this.makeResult(name, relativePath, sourceFile, node, 'arrow', query));
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
    return results;
  }

  private matches(name: string, lowerQuery: string): boolean {
    return name.toLowerCase().includes(lowerQuery);
  }

  private makeResult(
    name: string,
    filePath: string,
    sourceFile: ts.SourceFile,
    node: ts.Node,
    kind: ASTSearchResult['kind'],
    query: string,
  ): ASTSearchResult {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    const lines = sourceFile.text.split('\n');
    const signature = lines[start.line]?.trim().slice(0, 120);

    return {
      functionName: name,
      filePath,
      location: {
        startLine: start.line + 1,
        endLine: end.line + 1,
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
type AstLocatorParams = Static<typeof _astLocatorParams>;

export const astLocatorTool: AgentTool<typeof _astLocatorParams, ASTSearchResult[]> = {
  name: 'ast_code_locator',
  label: 'AST Code Locator',
  description: 'Find functions, classes, methods, or arrow functions by name using TypeScript AST. Returns file paths and exact line numbers.',
  parameters: _astLocatorParams,
  execute: async (_toolCallId, params: AstLocatorParams) => {
    const results = await _astLocatorInstance.search({
      query: params.query,
      scope: params.scope,
      limit: params.limit,
    });
    const text = results.length === 0
      ? `No symbols found matching "${params.query}"`
      : results.map((r) =>
          `${r.filePath}:${r.location.startLine}-${r.location.endLine} [${r.kind}] ${r.functionName}${r.signature ? ` — ${r.signature}` : ''}`
        ).join('\n');
    return { content: [{ type: 'text' as const, text }], details: results };
  },
};
