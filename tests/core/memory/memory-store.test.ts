import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMemoryDb } from '../../../src/core/memory/db.js';
import {
  writeEpisodeSync,
  formatEpisodeDetail,
  fmtTime,
  readRecentEpisodes,
} from '../../../src/core/memory/episode.js';
import { formatMemoryIndex } from '../../../src/core/memory/index-builder.js';
import { graphRetrieve } from '../../../src/core/memory/retrieval.js';
import { updateSemanticFacts, readSemanticFacts } from '../../../src/core/memory/semantic.js';
import { State } from '../../../src/core/types.js';
import type { Mission } from '../../../src/core/agent/types.js';
import type { ExecutedStep, StateResult } from '../../../src/core/types.js';

let tmpDir: string;
let projectRoot: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'memory-test-'));
  projectRoot = tmpDir;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeDb() {
  return initMemoryDb(tmpDir);
}

function makeMission(desc: string): Mission {
  return { id: `task-${Date.now()}`, description: desc, state: 'running' };
}

function makeFinalResult(success: boolean, output = ''): StateResult {
  return { state: State.DONE, success, output, toolCalls: [], nextState: State.DONE };
}

describe('writeEpisodeSync', () => {
  it('writes one episode and returns an id', () => {
    const db = makeDb();
    const mission = makeMission('fix the divide bug in calc.ts');
    const steps: ExecutedStep[] = [
      { state: State.LOCATE, focus: 'find calc.ts', output: '{"locations":[{"file":"src/calc.ts"}]}' },
      { state: State.MODIFY, focus: 'fix bug', output: '{"edited":["src/calc.ts"]}' },
    ];
    const result = makeFinalResult(true, 'done');
    const id = writeEpisodeSync(db, mission, steps, result, projectRoot);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('persists the episode in the database', () => {
    const db = makeDb();
    const mission = makeMission('review auth.ts');
    const steps: ExecutedStep[] = [];
    const result = makeFinalResult(true);
    writeEpisodeSync(db, mission, steps, result, projectRoot);
    const rows = db.prepare('SELECT * FROM episodes WHERE project_root = ?').all(projectRoot) as Array<{
      user_input: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_input).toBe('review auth.ts');
  });

  it('records success=1 for successful result', () => {
    const db = makeDb();
    writeEpisodeSync(db, makeMission('do something'), [], makeFinalResult(true), projectRoot);
    const row = db.prepare('SELECT success FROM episodes WHERE project_root = ?').get(projectRoot) as {
      success: number;
    };
    expect(row.success).toBe(1);
  });

  it('records success=0 for failed result', () => {
    const db = makeDb();
    writeEpisodeSync(db, makeMission('do something'), [], makeFinalResult(false, 'error msg'), projectRoot);
    const row = db.prepare('SELECT success FROM episodes WHERE project_root = ?').get(projectRoot) as {
      success: number;
    };
    expect(row.success).toBe(0);
  });
});

describe('formatMemoryIndex', () => {
  it('returns empty string when no episodes', () => {
    const db = makeDb();
    const result = formatMemoryIndex(db, projectRoot);
    expect(result).toBe('');
  });

  it('returns a string containing <memory> when episodes exist', () => {
    const db = makeDb();
    writeEpisodeSync(db, makeMission('fix the bug'), [], makeFinalResult(true), projectRoot);
    const result = formatMemoryIndex(db, projectRoot);
    expect(result).toContain('<memory>');
    expect(result).toContain('</memory>');
  });

  it('includes the total count in the index', () => {
    const db = makeDb();
    writeEpisodeSync(db, makeMission('task one'), [], makeFinalResult(true), projectRoot);
    writeEpisodeSync(db, makeMission('task two'), [], makeFinalResult(true), projectRoot);
    const result = formatMemoryIndex(db, projectRoot);
    expect(result).toContain('共 2 条记忆');
  });
});

describe('graphRetrieve', () => {
  it('returns empty array when db is empty', () => {
    const db = makeDb();
    const rows = graphRetrieve('fix calc.ts', db, projectRoot);
    expect(rows).toHaveLength(0);
  });

  it('retrieves episode matching file entity', () => {
    const db = makeDb();
    const mission = makeMission('fix the divide bug in calc.ts');
    const steps: ExecutedStep[] = [{ state: State.MODIFY, focus: 'fix', output: '{"edited":["src/calc.ts"]}' }];
    writeEpisodeSync(db, mission, steps, makeFinalResult(true), projectRoot);
    const rows = graphRetrieve('edit calc.ts', db, projectRoot);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('retrieves episode by action type keyword', () => {
    const db = makeDb();
    writeEpisodeSync(db, makeMission('review the code'), [], makeFinalResult(true), projectRoot);
    const rows = graphRetrieve('review something', db, projectRoot);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('updateSemanticFacts', () => {
  it('writes language preference when user input contains 中文', () => {
    const db = makeDb();
    updateSemanticFacts(db, { userInput: '用中文回答我', verifyCommands: [] }, projectRoot);
    const facts = readSemanticFacts(db, projectRoot);
    const pref = facts.find((f) => f.category === 'preference' && f.key === 'language' && f.value === 'zh');
    expect(pref).toBeDefined();
  });

  it('writes test_command fact when verifyCommands includes vitest', () => {
    const db = makeDb();
    updateSemanticFacts(db, { userInput: 'fix bug', verifyCommands: ['npx vitest run'] }, projectRoot);
    const facts = readSemanticFacts(db, projectRoot);
    const convention = facts.find((f) => f.category === 'convention' && f.value === 'npx vitest run');
    expect(convention).toBeDefined();
  });
});

describe('formatEpisodeDetail', () => {
  it('returns a formatted string with timestamp and user_input', () => {
    const db = makeDb();
    const mission = makeMission('check authentication flow');
    writeEpisodeSync(db, mission, [], makeFinalResult(true), projectRoot);
    const rows = readRecentEpisodes(db, projectRoot);
    expect(rows).toHaveLength(1);
    const detail = formatEpisodeDetail(rows[0]!);
    expect(detail).toContain('check authentication flow');
    expect(detail).toContain('success');
  });
});

describe('fmtTime', () => {
  it('formats unix timestamp to readable date string', () => {
    const ts = Math.floor(new Date('2025-01-15T10:30:00Z').getTime() / 1000);
    const result = fmtTime(ts);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});
