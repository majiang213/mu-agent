import ts from 'typescript';

/**
 * Symbol kinds the walker can emit. Superset of both consumers' vocabularies:
 * the graph builder maps everything except 'constructor' straight onto its
 * node_type column; the AST locator maps 'constructor' back to 'method'.
 */
export type SymbolKind = 'function' | 'class' | 'method' | 'arrow' | 'constructor';

/**
 * One raw symbol sighting in a source file. Names are always BARE (never
 * qualified) — qualifying `Class.method` is a graph-builder concern, applied
 * by the consumer. `className` is present (typed string) exactly on
 * 'method'/'constructor' records so consumers that want qualification don't
 * have to re-walk the AST. Lines are 1-indexed, matching both historical
 * consumers.
 */
export type RawSymbol = {
  /** Bare name; the literal string 'constructor' for constructor records. */
  name: string;
  startLine: number;
  endLine: number;
} & ({ kind: 'function' | 'class' | 'arrow'; className: null } | { kind: 'method' | 'constructor'; className: string });

/**
 * THE symbol-extraction walker — one AST visit shared by GraphBuilder
 * (SQLite index) and ASTLocator (model-facing search tool), which previously
 * each kept a private, subtly divergent visitor (C15).
 *
 * VISITING is union semantics: everything either old visitor looked at is
 * visited here — named function declarations, named class declarations,
 * identifier-named methods and constructors that are direct class members,
 * and identifier-named variables initialized with an arrow/function
 * expression. FILTERING is per-consumer: the graph builder drops
 * 'constructor' records and qualifies method names; the locator keeps
 * constructors (as methods) and bare names.
 *
 * Records come out in the same pre-order both old visitors used: the node
 * itself, then a class's direct members, then deep recursion — so consumers
 * that care about first-sighting-wins (INSERT OR IGNORE) or stable ordering
 * see no change.
 */
export function extractSymbols(sourceFile: ts.SourceFile): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  const startLine = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const endLine = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      symbols.push({
        kind: 'function',
        name: node.name.text,
        className: null,
        startLine: startLine(node),
        endLine: endLine(node),
      });
    } else if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;
      symbols.push({
        kind: 'class',
        name: className,
        className: null,
        startLine: startLine(node),
        endLine: endLine(node),
      });
      ts.forEachChild(node, (child) => {
        if (ts.isMethodDeclaration(child) && ts.isIdentifier(child.name)) {
          symbols.push({
            kind: 'method',
            name: child.name.text,
            className,
            startLine: startLine(child),
            endLine: endLine(child),
          });
        } else if (ts.isConstructorDeclaration(child)) {
          symbols.push({
            kind: 'constructor',
            name: 'constructor',
            className,
            startLine: startLine(child),
            endLine: endLine(child),
          });
        }
      });
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          // Line range is the whole statement's — both historical consumers
          // measured the VariableStatement node, not the declaration.
          symbols.push({
            kind: 'arrow',
            name: decl.name.text,
            className: null,
            startLine: startLine(node),
            endLine: endLine(node),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return symbols;
}
