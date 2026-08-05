import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initMemoryDb } from '../../../src/core/memory/db.js';
import { buildSearchableContent, writeEpisodeSync } from '../../../src/core/memory/episode.js';
import { applyEpisodeSummary } from '../../../src/core/memory/summarizer.js';
import { State } from '../../../src/core/types.js';
import type { ExecutedStep, StateResult } from '../../../src/core/types.js';
import type { Mission } from '../../../src/core/agent/types.js';

/**
 * Round-5 candidate 2: THE searchable-content recipe has one home, and the
 * summarizer's SQL half is testable without a model.
 * - writeEpisodeSync indexes structured fields (key_finding + files) via the
 *   same buildSearchableContent the summarizer later enriches;
 * - applyEpisodeSummary persists the summary, re-indexes with LLM fields,
 *   and drains pending_summaries.
 */

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mem-summarizer-'));
  db = initMemoryDb(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function ftsHits(term: string): number {
  const row = db.prepare(`SELECT count(*) AS c FROM episodes_fts WHERE episodes_fts MATCH ?`).get(term) as {
    c: number;
  };
  return row.c;
}

function writeTestEpisode(): string {
  const mission: Mission = { id: 'm1', description: 'fix the parser bug', state: 'completed' };
  const steps: ExecutedStep[] = [
    { state: State.RESEARCH, focus: 'inspect', output: JSON.stringify({ summary: 'uniquefindingtoken root cause' }) },
    { state: State.MODIFY, focus: 'fix', output: JSON.stringify({ edited: ['uniquefiletoken.ts'], linesChanged: 3 }) },
  ];
  const finalResult: StateResult = { success: true, output: 'done' };
  return writeEpisodeSync(db, mission, steps, finalResult, dir);
}

describe('buildSearchableContent — THE one recipe', () => {
  it('includes user_input + structured fields without LLM fields', () => {
    const content = buildSearchableContent('task text', { key_finding: 'the cause', files: ['a.ts'] });
    expect(content).toContain('task text');
    expect(content).toContain('the cause');
    expect(content).toContain('a.ts');
  });

  it('adds LLM description + keywords when present', () => {
    const content = buildSearchableContent(
      'task text',
      { key_finding: 'the cause', files: ['a.ts'] },
      { description: 'one-liner', keywords: ['kw1', 'kw2'] },
    );
    for (const part of ['task text', 'one-liner', 'kw1', 'kw2', 'the cause', 'a.ts']) {
      expect(content).toContain(part);
    }
  });
});

describe('writeEpisodeSync — insert-time FTS row uses the recipe', () => {
  it('indexes key_finding and edited files, not raw result_summary JSON', () => {
    writeTestEpisode();
    expect(ftsHits('uniquefindingtoken')).toBe(1);
    expect(ftsHits('uniquefiletoken')).toBe(1);
    // Raw JSON field names are NOT indexed (the old trigger indexed them).
    expect(ftsHits('key_finding')).toBe(0);
    expect(ftsHits('locate_files')).toBe(0);
  });

  it('leaves the episode pending summarization', () => {
    const id = writeTestEpisode();
    const pending = db.prepare(`SELECT episode_id FROM pending_summaries WHERE episode_id = ?`).get(id);
    expect(pending).toBeDefined();
  });
});

describe('applyEpisodeSummary — pure SQL half, no model', () => {
  it('persists the summary, drains pending, and re-indexes with LLM fields', () => {
    const id = writeTestEpisode();

    applyEpisodeSummary(db, id, { description: 'fixed parser null handling', keywords: ['llmkeywordtoken', 'parser'] });

    const ep = db.prepare(`SELECT description, keywords FROM episodes WHERE id = ?`).get(id) as {
      description: string;
      keywords: string;
    };
    expect(ep.description).toBe('fixed parser null handling');
    expect(JSON.parse(ep.keywords)).toEqual(['llmkeywordtoken', 'parser']);

    expect(db.prepare(`SELECT episode_id FROM pending_summaries WHERE episode_id = ?`).get(id)).toBeUndefined();

    // Re-indexed with the SAME recipe: LLM fields now findable, structured
    // fields retained.
    expect(ftsHits('llmkeywordtoken')).toBe(1);
    expect(ftsHits('uniquefindingtoken')).toBe(1);
    expect(ftsHits('uniquefiletoken')).toBe(1);
  });

  it('does not throw when the episode row is missing', () => {
    expect(() => applyEpisodeSummary(db, 'nonexistent-id', { description: 'x', keywords: [] })).not.toThrow();
    // The pending row delete still runs (idempotent no-op).
  });
});
