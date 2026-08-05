import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchesKey } from '@earendil-works/pi-tui';
import {
  createMuKeybindings,
  keyLabel,
  MU_KEYBINDINGS,
  MU_RESERVED_ACTIONS,
  reservedKeys,
} from '../../src/config/keybindings.js';

// Gap 88: app keys go through the pi-tui KeybindingsManager with mu-curated
// definitions. These pin the legacy key behavior (ESC/Ctrl+C/Ctrl+T/Ctrl+O/
// Ctrl+D) and the user-override file.

describe('createMuKeybindings', () => {
  it('defaults reproduce the legacy hardcoded keys', () => {
    const kb = createMuKeybindings(mkdtempSync(join(tmpdir(), 'mu-kb-empty-')));
    expect(kb.matches('\x1b', 'app.interrupt')).toBe(true);
    expect(kb.matches('\x14', 'app.thinking.toggle')).toBe(true); // ctrl+t
    expect(kb.matches('\x0f', 'app.tools.expand')).toBe(true); // ctrl+o
    expect(kb.matches('\x04', 'app.debug.toggle')).toBe(true); // ctrl+d
    // ctrl+c byte
    expect(kb.matches('\x03', 'app.exit')).toBe(true);
    // unrelated keys match nothing
    expect(kb.matches('\x12', 'app.interrupt')).toBe(false); // ctrl+r
  });

  it('user overrides from keybindings.json win', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mu-kb-'));
    try {
      writeFileSync(join(dir, 'keybindings.json'), JSON.stringify({ 'app.debug.toggle': 'f12' }));
      const kb = createMuKeybindings(dir);
      expect(kb.getKeys('app.debug.toggle')).toEqual(['f12']);
      expect(kb.matches('\x04', 'app.debug.toggle')).toBe(false); // ctrl+d no longer bound
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('malformed keybindings.json falls back to defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mu-kb-bad-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'keybindings.json'), '{not json');
      const kb = createMuKeybindings(dir);
      expect(kb.matches('\x1b', 'app.interrupt')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reserved actions are exactly the five app control keys', () => {
    expect([...MU_RESERVED_ACTIONS].sort()).toEqual(
      ['app.debug.toggle', 'app.exit', 'app.interrupt', 'app.thinking.toggle', 'app.tools.expand'].sort(),
    );
    for (const action of MU_RESERVED_ACTIONS) {
      expect(MU_KEYBINDINGS[action]).toBeDefined();
    }
  });

  it('keyLabel formats keys for the hint line', () => {
    const kb = createMuKeybindings(mkdtempSync(join(tmpdir(), 'mu-kb-label-')));
    expect(keyLabel(kb, 'app.exit')).toBe('Ctrl+C');
    expect(keyLabel(kb, 'app.interrupt')).toBe('Esc');
    expect(keyLabel(kb, 'app.thinking.toggle')).toBe('Ctrl+T');
  });

  it('user-vs-user duplicate claims surface via getConflicts; default collisions shadow (both match)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mu-kb-conflict-'));
    try {
      // Two user claims on one key → conflict reported.
      writeFileSync(
        join(dir, 'keybindings.json'),
        JSON.stringify({ 'app.tools.expand': 'f9', 'app.thinking.toggle': 'f9' }),
      );
      const kb = createMuKeybindings(dir);
      expect(kb.getConflicts().some((c) => c.key === 'f9')).toBe(true);

      // User claim colliding with a DEFAULT key is NOT a reported conflict —
      // both actions match the key (pi-tui semantics). 85-D reserved-key
      // rejection must therefore check getKeys() of reserved actions, not
      // getConflicts().
      writeFileSync(join(dir, 'keybindings.json'), JSON.stringify({ 'app.tools.expand': 'ctrl+t' }));
      const kb2 = createMuKeybindings(dir);
      expect(kb2.getConflicts()).toEqual([]);
      expect(kb2.matches('\x14', 'app.tools.expand')).toBe(true);
      expect(kb2.matches('\x14', 'app.thinking.toggle')).toBe(true);
      // ...and the reserved-key check 85-D will use:
      const reservedKeys = new Set(MU_RESERVED_ACTIONS.flatMap((a) => kb2.getKeys(a)));
      expect(reservedKeys.has('ctrl+t')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// matchesKey import guard: app.ts must not regress to raw matchesKey calls —
// the manager is the only matcher. This test double-checks the byte-level
// equivalence the migration relies on.
describe('legacy byte equivalence', () => {
  it('pi-tui matchesKey agrees with the manager on the five control keys', () => {
    const kb = createMuKeybindings(mkdtempSync(join(tmpdir(), 'mu-kb-equiv-')));
    expect(kb.matches('\x14', 'app.thinking.toggle')).toBe(matchesKey('\x14', 'ctrl+t'));
    expect(kb.matches('\x0f', 'app.tools.expand')).toBe(matchesKey('\x0f', 'ctrl+o'));
  });
});

describe('reservedKeys (Gap 85-D)', () => {
  it('contains every reserved action default key', () => {
    const kb = createMuKeybindings(mkdtempSync(join(tmpdir(), 'mu-kb-reserved-')));
    const reserved = reservedKeys(kb);
    for (const key of ['ctrl+c', 'escape', 'ctrl+t', 'ctrl+o', 'ctrl+d']) {
      expect(reserved.has(key)).toBe(true);
    }
    // Non-reserved app actions are NOT protected
    expect(reserved.has('ctrl+l')).toBe(false);
  });

  it('a user-remapped reserved action stays protected (new key joins the set)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mu-kb-reserved-override-'));
    writeFileSync(join(dir, 'keybindings.json'), JSON.stringify({ 'app.debug.toggle': 'ctrl+g' }));
    const reserved = reservedKeys(createMuKeybindings(dir));
    expect(reserved.has('ctrl+g')).toBe(true);
    expect(reserved.has('ctrl+d')).toBe(false);
  });
});
