import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { extractSymbols } from '../../../src/core/graph/symbols.js';

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

describe('extractSymbols — call sightings (round-5 candidate 7)', () => {
  it('emits call records with bare caller/callee identities', () => {
    const sf = parse(`
function outer() { helper(); }
function helper() {}
class Greeter {
  greet() { this.render(); helper(); }
  render() {}
}
const arrowFn = () => { helper(); };
`);
    const calls = extractSymbols(sf).filter((r) => r.kind === 'call');
    expect(calls).toContainEqual({ kind: 'call', callee: 'helper', callerName: 'outer', callerClassName: null });
    expect(calls).toContainEqual({ kind: 'call', callee: 'render', callerName: 'greet', callerClassName: 'Greeter' });
    expect(calls).toContainEqual({ kind: 'call', callee: 'helper', callerName: 'greet', callerClassName: 'Greeter' });
    expect(calls).toContainEqual({ kind: 'call', callee: 'helper', callerName: 'arrowFn', callerClassName: null });
  });

  it('does not emit call records at top level (matches the old walker)', () => {
    const sf = parse(`topLevelCall();`);
    expect(extractSymbols(sf).filter((r) => r.kind === 'call')).toHaveLength(0);
  });

  it('still emits symbol records in pre-order alongside calls', () => {
    const sf = parse(`function a() { b(); }\nfunction b() {}`);
    const kinds = extractSymbols(sf).map((r) => r.kind);
    expect(kinds).toEqual(['function', 'call', 'function']);
  });
});
