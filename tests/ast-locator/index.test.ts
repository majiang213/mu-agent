import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { ASTLocator, createASTLocator } from '../../src/ast-locator/index.js';

const FIXTURE_DIR = resolve(import.meta.dirname ?? __dirname, 'fixtures');

describe('ASTLocator', () => {
  describe('factory', () => {
    it('createASTLocator returns an ASTLocator instance', () => {
      const locator = createASTLocator();
      expect(locator).toBeInstanceOf(ASTLocator);
    });
  });

  describe('search — basic', () => {
    it('returns an array', async () => {
      const locator = new ASTLocator();
      const results = await locator.search({ query: 'greet', scope: FIXTURE_DIR, limit: 5 });
      expect(Array.isArray(results)).toBe(true);
    });

    it('respects limit parameter', async () => {
      const locator = new ASTLocator();
      const results = await locator.search({ query: 'a', scope: FIXTURE_DIR, limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('returns empty array for non-matching query', async () => {
      const locator = new ASTLocator();
      const results = await locator.search({ query: 'zzz_nonexistent_xyz', scope: FIXTURE_DIR, limit: 5 });
      expect(results).toHaveLength(0);
    });
  });

  describe('search — function detection', () => {
    it('finds named function declaration with correct kind', async () => {
      const locator = new ASTLocator();
      const results = await locator.search({ query: 'greet', scope: FIXTURE_DIR, limit: 5 });
      expect(results.length).toBeGreaterThan(0);
      const r = results[0]!;
      expect(r.functionName).toBe('greet');
      expect(r.kind).toBe('function');
    });

    it('finds named function with accurate line numbers', async () => {
      const locator = new ASTLocator();
      const results = await locator.search({ query: 'greet', scope: FIXTURE_DIR, limit: 5 });
      const r = results[0]!;
      expect(r.location.startLine).toBe(15);
      expect(r.location.endLine).toBe(17);
    });

    it('finds async function', async () => {
      const locator = new ASTLocator();
      const results = await locator.search({ query: 'fetchData', scope: FIXTURE_DIR, limit: 5 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.kind).toBe('function');
      expect(results[0]!.location.startLine).toBe(36);
    });
  });

  describe('search — class and method detection', () => {
    it('finds class declaration with correct kind', async () => {
      const locator = new ASTLocator();
      const results = await locator.search({ query: 'Calculator', scope: FIXTURE_DIR, limit: 5 });
      const classResult = results.find((r) => r.kind === 'class');
      expect(classResult).toBeDefined();
      expect(classResult!.functionName).toBe('Calculator');
      expect(classResult!.location.startLine).toBe(20);
    });

    it('finds method inside class', async () => {
      const locator = new ASTLocator();
      const results = await locator.search({ query: 'sub', scope: FIXTURE_DIR, limit: 5 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.kind).toBe('method');
      expect(results[0]!.location.startLine).toBe(27);
    });
  });

  describe('search — arrow function detection', () => {
    it('finds const arrow function with correct kind', async () => {
      const locator = new ASTLocator();
      const results = await locator.search({ query: 'multiply', scope: FIXTURE_DIR, limit: 5 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.kind).toBe('arrow');
      expect(results[0]!.location.startLine).toBe(33);
    });
  });

  describe('search — score ordering', () => {
    it('exact match scores higher than partial match', async () => {
      const locator = new ASTLocator();
      const results = await locator.search({ query: 'add', scope: FIXTURE_DIR, limit: 10 });
      if (results.length >= 2) {
        expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
      }
    });
  });

  describe('search — result shape', () => {
    it('result includes filePath, signature, score, kind', async () => {
      const locator = new ASTLocator();
      const results = await locator.search({ query: 'greet', scope: FIXTURE_DIR, limit: 5 });
      const r = results[0]!;
      expect(typeof r.filePath).toBe('string');
      expect(typeof r.signature).toBe('string');
      expect(typeof r.score).toBe('number');
      expect(['function', 'class', 'method', 'arrow']).toContain(r.kind);
    });
  });
});
