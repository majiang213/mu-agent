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
 * One call sighting: a CallExpression inside a function-like scope, with the
 * caller's identity the walker tracked on the way down (round-5, candidate
 * 7 — previously a second private walker in builder.ts re-derived this).
 * Names are BARE; qualifying `Class.method` for the caller is the consumer's
 * concern, exactly like symbol records.
 */
export type RawCall = {
  kind: 'call';
  /** Bare callee name (identifier, or property-access member name). */
  callee: string;
  /** Bare name of the enclosing function / method / arrow. */
  callerName: string;
  /** Class name when the caller is a class method, else null. */
  callerClassName: string | null;
};

export type SymbolRecord = RawSymbol | RawCall;

/**
 * THE source-file walker — one AST visit shared by GraphBuilder (SQLite
 * nodes AND call edges) and ASTLocator (model-facing search tool) (C15,
 * extended in round-5 candidate 7 to also emit call sightings; the builder's
 * private second walker is gone).
 *
 * VISITING is union semantics: everything either old visitor looked at is
 * visited here — named function declarations, named class declarations,
 * identifier-named methods and constructors that are direct class members,
 * identifier-named variables initialized with an arrow/function expression,
 * AND call expressions inside those scopes (never at top level, matching the
 * old call walker). FILTERING is per-consumer: the graph builder drops
 * 'constructor' records, qualifies method names, and turns 'call' records
 * into edges; the locator keeps constructors (as methods) and skips 'call'.
 *
 * Symbol records come out in the same pre-order both old visitors used: the
 * node itself, then a class's direct members, then deep recursion — so
 * consumers that care about first-sighting-wins (INSERT OR IGNORE) or stable
 * ordering see no change.
 */
export function extractSymbols(sourceFile: ts.SourceFile): SymbolRecord[] {
  const records: SymbolRecord[] = [];

  const startLine = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const endLine = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

  type Enclosing = { name: string; className: string | null };

  const visit = (node: ts.Node, enclosing: Enclosing | null): void => {
    let current = enclosing;
    if (ts.isFunctionDeclaration(node) && node.name) {
      current = { name: node.name.text, className: null };
      records.push({
        kind: 'function',
        name: node.name.text,
        className: null,
        startLine: startLine(node),
        endLine: endLine(node),
      });
    } else if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;
      records.push({
        kind: 'class',
        name: className,
        className: null,
        startLine: startLine(node),
        endLine: endLine(node),
      });
      ts.forEachChild(node, (child) => {
        if (ts.isMethodDeclaration(child) && ts.isIdentifier(child.name)) {
          records.push({
            kind: 'method',
            name: child.name.text,
            className,
            startLine: startLine(child),
            endLine: endLine(child),
          });
        } else if (ts.isConstructorDeclaration(child)) {
          records.push({
            kind: 'constructor',
            name: 'constructor',
            className,
            startLine: startLine(child),
            endLine: endLine(child),
          });
        }
      });
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      // Enclosing identity for calls in the method body (the record itself
      // was emitted by the class branch's direct-member pass).
      const parent = node.parent;
      const className = ts.isClassDeclaration(parent) && parent.name ? parent.name.text : null;
      current = { name: node.name.text, className };
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          // Line range is the whole statement's — both historical consumers
          // measured the VariableStatement node, not the declaration.
          records.push({
            kind: 'arrow',
            name: decl.name.text,
            className: null,
            startLine: startLine(node),
            endLine: endLine(node),
          });
        }
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      // Enclosing identity for calls inside the arrow/function body.
      current = { name: node.name.text, className: null };
    }

    if (ts.isCallExpression(node) && current) {
      let callee: string | null = null;
      if (ts.isIdentifier(node.expression)) {
        callee = node.expression.text;
      } else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)) {
        callee = node.expression.name.text;
      }
      if (callee) {
        records.push({ kind: 'call', callee, callerName: current.name, callerClassName: current.className });
      }
    }

    ts.forEachChild(node, (child) => visit(child, current));
  };

  ts.forEachChild(sourceFile, (child) => visit(child, null));
  return records;
}
