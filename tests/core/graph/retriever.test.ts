import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphBuilder } from '../../../src/core/graph/builder.js';
import { GraphRetriever } from '../../../src/core/graph/retriever.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-retriever-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function buildGraph(): GraphRetriever {
  writeFileSync(
    join(dir, 'calc.ts'),
    `export function foo_bar(x: number): number { return x * 2; }\nexport function unrelated(): number { return 1; }\n`,
    'utf-8',
  );
  new GraphBuilder(dir).buildFull();
  return new GraphRetriever(dir);
}

describe('GraphRetriever — unified tokenizer + real tf', () => {
  it('a snake_case query matches snake_case doc tokens (was impossible with split(/\\s+/))', () => {
    const retriever = buildGraph();
    try {
      const results = retriever.retrieve('foo_bar');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.name === 'foo_bar')).toBe(true);
    } finally {
      retriever.close();
    }
  });

  it('repeated tokens in a name score higher (tf is real, not boolean)', () => {
    writeFileSync(
      join(dir, 'repeat.ts'),
      `export function alpha_alpha_beta() { return 1; }\nexport function alpha_beta() { return 2; }\n`,
      'utf-8',
    );
    new GraphBuilder(dir).buildFull();
    const retriever = new GraphRetriever(dir);
    try {
      const results = retriever.retrieve('alpha', 10);
      const repeated = results.find((r) => r.name === 'alpha_alpha_beta');
      const single = results.find((r) => r.name === 'alpha_beta');
      expect(repeated).toBeDefined();
      expect(single).toBeDefined();
      expect(repeated!.bm25Score).toBeGreaterThan(single!.bm25Score);
    } finally {
      retriever.close();
    }
  });
});
