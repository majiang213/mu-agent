import { describe, it, expect } from 'vitest';
import {
  formatRunResult,
  assistantMessageForSession,
  stripLegacyPrefix,
  LEGACY_ASSISTANT_PREFIX,
} from '../../src/tui/presenter.js';

describe('formatRunResult', () => {
  it('returns empty for undefined / Task completed', () => {
    expect(formatRunResult(undefined)).toBe('');
    expect(formatRunResult('Task completed')).toBe('');
  });

  it('prefers the answer field (ANSWER schema)', () => {
    expect(formatRunResult(JSON.stringify({ answer: 'Fixed calc.js divide guard' }))).toBe(
      'Fixed calc.js divide guard',
    );
  });

  it('falls back to report then summary', () => {
    expect(formatRunResult(JSON.stringify({ report: 'Found 3 issues' }))).toBe('Found 3 issues');
    expect(formatRunResult(JSON.stringify({ summary: 'tests passed' }))).toBe('tests passed');
  });

  it('answer wins over report when both exist', () => {
    expect(formatRunResult(JSON.stringify({ answer: 'A', report: 'R' }))).toBe('A');
  });

  it('renders edited files with optional line count (MODIFY schema)', () => {
    expect(formatRunResult(JSON.stringify({ edited: ['a.ts', 'b.ts'], linesChanged: 42 }))).toBe(
      'Edited: a.ts, b.ts, 42 lines',
    );
    expect(formatRunResult(JSON.stringify({ edited: ['a.ts'] }))).toBe('Edited: a.ts');
  });

  it('renders locations with optional line numbers (LOCATE schema)', () => {
    expect(formatRunResult(JSON.stringify({ locations: [{ file: 'a.ts', startLine: 10 }, { file: 'b.ts' }] }))).toBe(
      'a.ts:10, b.ts',
    );
  });

  it('returns raw output when it is not JSON', () => {
    expect(formatRunResult('plain text answer')).toBe('plain text answer');
  });

  it('returns empty for JSON without known fields', () => {
    expect(formatRunResult(JSON.stringify({ steps: [] }))).toBe('');
  });
});

describe('session message shaping', () => {
  it('persists assistant content without a presentation prefix', () => {
    const msg = assistantMessageForSession('the answer', 123);
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('the answer');
    expect(msg.content.startsWith(LEGACY_ASSISTANT_PREFIX)).toBe(false);
    expect(msg.timestamp).toBe(123);
  });

  it('strips the legacy prefix from loaded messages', () => {
    expect(stripLegacyPrefix(`${LEGACY_ASSISTANT_PREFIX}old answer`)).toBe('old answer');
  });

  it('leaves unprefixed content untouched', () => {
    expect(stripLegacyPrefix('clean answer')).toBe('clean answer');
  });
});
