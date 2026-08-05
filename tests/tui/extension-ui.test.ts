import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { Component, KeybindingsManager, TUI } from '@earendil-works/pi-tui';
import type { Editor } from '@earendil-works/pi-tui';
import { createExtensionUI } from '../../src/tui/extension-ui.js';
import type { ExtensionUIDeps } from '../../src/tui/extension-ui.js';
import { initMuAgentTheme } from '../../src/tui/theme.js';

/**
 * Gap 85-D: the non-dialog ExtensionUIContext surface, tested against fake
 * deps (dialogs need a live terminal — covered by fixture runs).
 */
function makeDeps() {
  const insertedAbove: Component[] = [];
  const insertedBelow: Component[] = [];
  const removed: Component[] = [];
  const notifications: Array<{ message: string; type: string }> = [];
  const warnings: string[] = [];
  const inputListeners: Array<(data: string) => unknown> = [];
  const editor = {
    text: '',
    setText(t: string) {
      this.text = t;
    },
    getText() {
      return this.text;
    },
    insertTextAtCursor(t: string) {
      this.text += t;
    },
  };
  // Single-point cast: the fake covers exactly the TUI surface the non-dialog
  // paths touch (requestRender/addInputListener); dialogs are terminal-only.
  const tui = {
    requestRender: vi.fn(),
    addInputListener: vi.fn((l: (data: string) => unknown) => {
      inputListeners.push(l);
      return () => {};
    }),
  } as unknown as TUI;
  const deps: ExtensionUIDeps = {
    tui,
    editor: editor as unknown as Editor,
    keybindings: {} as unknown as KeybindingsManager,
    notifyLine: (message, type) => notifications.push({ message, type }),
    warn: (msg) => warnings.push(msg),
    insertAboveEditor: (c) => insertedAbove.push(c),
    insertBelowEditor: (c) => insertedBelow.push(c),
    removeComponent: (c) => removed.push(c),
    replaceHeader: vi.fn(),
    replaceFooter: vi.fn(),
    getToolsExpanded: () => toolsExpanded,
    setToolsExpanded: (v) => {
      toolsExpanded = v;
    },
    dialogOpenChanged: vi.fn(),
  };
  let toolsExpanded = false;
  return { deps, insertedAbove, insertedBelow, removed, notifications, warnings, inputListeners, editor };
}

beforeAll(async () => {
  await initMuAgentTheme();
});

describe('createExtensionUI (Gap 85-D)', () => {
  it('notify routes to the scrollback line with a default level', () => {
    const { deps, notifications } = makeDeps();
    const ui = createExtensionUI(deps);
    ui.notify('hello');
    ui.notify('bad', 'error');
    expect(notifications).toEqual([
      { message: 'hello', type: 'info' },
      { message: 'bad', type: 'error' },
    ]);
  });

  it('setStatus aggregates keys into one line; clearing all removes it', () => {
    const { deps, insertedBelow, removed } = makeDeps();
    const ui = createExtensionUI(deps);
    ui.setStatus('a', 'first');
    ui.setStatus('b', 'second');
    expect(insertedBelow).toHaveLength(1); // single status line, updated in place
    ui.setStatus('a', undefined);
    ui.setStatus('b', undefined);
    expect(removed).toHaveLength(1);
  });

  it('setWidget inserts string content; same-key replace disposes the old; undefined clears', () => {
    const { deps, insertedAbove, removed } = makeDeps();
    const ui = createExtensionUI(deps);
    ui.setWidget('w1', ['line one', 'line two']);
    expect(insertedAbove).toHaveLength(1);
    const first = insertedAbove[0]!;
    ui.setWidget('w1', ['replaced']);
    expect(removed).toContain(first);
    expect(insertedAbove).toHaveLength(2);
    ui.setWidget('w1', undefined);
    expect(removed).toHaveLength(2);
  });

  it('setWidget belowEditor placement routes to the below zone', () => {
    const { deps, insertedAbove, insertedBelow } = makeDeps();
    const ui = createExtensionUI(deps);
    ui.setWidget('w', ['x'], { placement: 'belowEditor' });
    expect(insertedBelow).toHaveLength(1);
    expect(insertedAbove).toHaveLength(0);
  });

  it('setWidget factory receives (tui, liveTheme)', () => {
    const { deps, insertedAbove } = makeDeps();
    const ui = createExtensionUI(deps);
    const factory = vi.fn((t: unknown, theme: unknown) => {
      expect(t).toBe(deps.tui);
      expect(theme).toBe(ui.theme);
      return { render: () => [], invalidate: () => {} } as Component & { dispose?(): void };
    });
    ui.setWidget('f', factory);
    expect(factory).toHaveBeenCalledOnce();
    expect(insertedAbove).toHaveLength(1);
  });

  it('editor text accessors delegate to the TUI editor', () => {
    const { deps, editor } = makeDeps();
    const ui = createExtensionUI(deps);
    ui.setEditorText('abc');
    expect(editor.text).toBe('abc');
    expect(ui.getEditorText()).toBe('abc');
    ui.pasteToEditor('DEF');
    expect(editor.text).toBe('abcDEF');
  });

  it('getToolsExpanded/setToolsExpanded pass through to the host', () => {
    const { deps } = makeDeps();
    const ui = createExtensionUI(deps);
    expect(ui.getToolsExpanded()).toBe(false);
    ui.setToolsExpanded(true);
    expect(ui.getToolsExpanded()).toBe(true);
  });

  it('theme surface: getAllThemes lists built-ins; setTheme delegates; unknown theme errors', () => {
    const { deps } = makeDeps();
    const ui = createExtensionUI(deps);
    const names = ui.getAllThemes().map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    expect(ui.theme).toBeDefined();
    const bad = ui.setTheme('definitely-not-a-theme');
    expect(bad.success).toBe(false);
  });

  it('onTerminalInput subscribes through tui.addInputListener and returns an unsubscribe', () => {
    const { deps, inputListeners } = makeDeps();
    const ui = createExtensionUI(deps);
    const unsub = ui.onTerminalInput(() => undefined);
    expect(inputListeners).toHaveLength(1);
    expect(typeof unsub).toBe('function');
  });

  it('unsupported knobs warn exactly once', () => {
    const { deps, warnings } = makeDeps();
    const ui = createExtensionUI(deps);
    ui.setWorkingVisible(false);
    ui.setWorkingVisible(true);
    ui.setHiddenThinkingLabel('x');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('setWorkingVisible');
    expect(warnings[1]).toContain('setHiddenThinkingLabel');
  });

  it('setHeader/setFooter forward to the zone swap; undefined restores', () => {
    const { deps } = makeDeps();
    const ui = createExtensionUI(deps);
    const comp = { render: () => [], invalidate: () => {} } as Component;
    ui.setHeader(() => comp);
    expect(deps.replaceHeader).toHaveBeenCalledWith(comp);
    ui.setHeader(undefined);
    expect(deps.replaceHeader).toHaveBeenLastCalledWith(undefined);
    ui.setFooter(() => comp);
    expect(deps.replaceFooter).toHaveBeenCalledWith(comp);
  });
});
