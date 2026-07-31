import { describe, it, expect } from 'vitest';
import { forkRunConfig, findOverlappingEdits } from '../../../src/core/agent/step-context.js';
import { parseEditedFiles } from '../../../src/core/step-outputs.js';
import type { RunConfig } from '../../../src/core/agent/types.js';

function makeCfg(): RunConfig {
  const safeModifier = { marker: 'shared-safe-modifier' };
  const stateMachine = {
    clone() {
      return { marker: 'cloned-state-machine' };
    },
  };
  return {
    safeModifier,
    stateMachine,
    temperature: 0.1,
  } as unknown as RunConfig;
}

describe('forkRunConfig', () => {
  it('shares the safeModifier checkpoint store with the parent (rollback sees branch edits)', () => {
    const cfg = makeCfg();
    const branch = forkRunConfig(cfg);
    expect(branch.safeModifier).toBe(cfg.safeModifier);
  });

  it('clones the state machine (branch file-count limits are independent)', () => {
    const cfg = makeCfg();
    const branch = forkRunConfig(cfg);
    expect(branch.stateMachine).not.toBe(cfg.stateMachine);
    expect((branch.stateMachine as unknown as { marker: string }).marker).toBe('cloned-state-machine');
  });

  it('is a new object (per-branch temperature mutations stay local)', () => {
    const cfg = makeCfg();
    const branch = forkRunConfig(cfg);
    expect(branch).not.toBe(cfg);
    branch.temperature = 0.5;
    expect(cfg.temperature).toBe(0.1);
  });
});

describe('parseEditedFiles', () => {
  it('parses the edited list from MODIFY complete() output', () => {
    expect(parseEditedFiles('{"edited":["a.ts","b.ts"],"linesChanged":12}')).toEqual(['a.ts', 'b.ts']);
  });

  it('returns [] for non-JSON output', () => {
    expect(parseEditedFiles('not json')).toEqual([]);
  });

  it('returns [] when edited is missing or not an array', () => {
    expect(parseEditedFiles('{"linesChanged":3}')).toEqual([]);
    expect(parseEditedFiles('{"edited":"a.ts"}')).toEqual([]);
  });

  it('filters non-string entries', () => {
    expect(parseEditedFiles('{"edited":["a.ts",42,null]}')).toEqual(['a.ts']);
  });
});

describe('findOverlappingEdits', () => {
  it('returns files edited by more than one branch', () => {
    expect(findOverlappingEdits([['a.ts', 'b.ts'], ['b.ts', 'c.ts'], ['d.ts']])).toEqual(['b.ts']);
  });

  it('returns [] when all branches are disjoint', () => {
    expect(findOverlappingEdits([['a.ts'], ['b.ts']])).toEqual([]);
  });

  it('deduplicates within a branch before counting', () => {
    expect(findOverlappingEdits([['a.ts', 'a.ts']])).toEqual([]);
  });

  it('handles empty branches', () => {
    expect(findOverlappingEdits([[], ['a.ts'], []])).toEqual([]);
  });
});
