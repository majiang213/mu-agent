import { describe, it, expect } from 'vitest';
import {
  initMuAgentTheme,
  listThemes,
  C,
  stateColor,
  fillLine,
  markdownTheme,
  selectTheme,
  STATE_FN,
} from '../../src/tui/theme.js';
import { State } from '../../src/core/types.js';

// Gap 87: theme.ts is a thin adapter over pi's Theme — these tests pin the
// adapter contract (init idempotency, accessor shape, state rainbow
// completeness), not specific colors (those are the theme's business).

describe('theme adapter (Gap 87)', () => {
  it('initializes and stays idempotent', async () => {
    await initMuAgentTheme();
    await expect(initMuAgentTheme()).resolves.toBeUndefined();
  });

  it('C accessors produce ANSI-wrapped strings', () => {
    const out = C.err('boom');
    expect(out).toContain('boom');
    expect(out).not.toBe('boom'); // wrapped in escape codes
    expect(C.dim('x')).toContain('x');
    expect(C.ok('y')).toContain('y');
  });

  it('every State has a color function (compile-time Record + runtime check)', () => {
    for (const s of Object.values(State)) {
      expect(typeof STATE_FN[s]).toBe('function');
      expect(stateColor(s)(s)).toContain(s);
    }
    // pseudo-states + unknown fall back without throwing
    expect(stateColor('SAMPLING')('s')).toContain('s');
    expect(stateColor('NOPE')('n')).toContain('n');
  });

  it('fillLine pads to width with the user-message background', () => {
    const line = fillLine('hi', 10);
    expect(line).toContain('hi');
    expect(line.length).toBeGreaterThan(10); // ansi + padding
  });

  it('markdown/select themes resolve through the live pi theme', () => {
    expect(typeof markdownTheme.heading).toBe('function');
    expect(markdownTheme.heading('H')).toContain('H');
    expect(typeof selectTheme.selectedPrefix).toBe('function');
  });

  it('listThemes returns at least the pi built-ins', async () => {
    const names = (await listThemes()).map((t) => t.name);
    expect(names).toContain('dark');
    expect(names).toContain('light');
  });
});
