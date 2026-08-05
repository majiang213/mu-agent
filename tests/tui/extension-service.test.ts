import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { TUI, Editor } from '@earendil-works/pi-tui';

import { ExtensionService } from '../../src/tui/extension-service.js';
import type { ExtensionServiceHost } from '../../src/tui/extension-service.js';
import type { ExtensionUIDeps } from '../../src/tui/extension-ui.js';
import type { ExtensionHostState } from '../../src/core/extensions/host-actions.js';
import { createMuKeybindings } from '../../src/config/keybindings.js';
import type { Config } from '../../src/config/types.js';

/**
 * ExtensionService (architecture review 2026-08-05, candidate 3) — headless
 * tests through the ExtensionServiceHost seam: recording fakes for the app
 * callbacks, a real tmpdir extensions dir, and the real loader (the runtime
 * singleton runs with allowModelNetwork: false, so nothing leaves the box).
 */

declare global {
  // Extension files are loaded via jiti — they communicate with the test
  // through this global bag instead of imports (tmp dirs can't resolve deps).
  var __extCalls: Array<unknown>;
}

let projectRoot: string;
let extDir: string;

function makeConfig(): Config {
  return { model: { provider: 'ollama', name: 'test-model', baseUrl: 'http://localhost:11434' } };
}

function makeUiDeps(): Omit<ExtensionUIDeps, 'dialogOpenChanged'> {
  return {
    tui: { requestRender: vi.fn(), addInputListener: vi.fn(() => () => {}) } as unknown as TUI,
    editor: {} as unknown as Editor,
    keybindings: createMuKeybindings(),
    notifyLine: vi.fn(),
    warn: vi.fn(),
    insertAboveEditor: vi.fn(),
    insertBelowEditor: vi.fn(),
    removeComponent: vi.fn(),
    replaceHeader: vi.fn(),
    replaceFooter: vi.fn(),
    getToolsExpanded: () => false,
    setToolsExpanded: vi.fn(),
  };
}

function makeHost(root: string): { host: ExtensionServiceHost; notes: Array<{ message: string; level: string }> } {
  const notes: Array<{ message: string; level: string }> = [];
  const host: ExtensionServiceHost = {
    notify: (message, level) => {
      notes.push({ message, level });
    },
    enqueueMission: vi.fn(),
    isBusy: () => false,
    switchSessionStore: vi.fn(),
    sessionManager: () => SessionManager.inMemory(root),
    currentModel: () => undefined,
    requestModelSwitch: () => true,
  };
  return { host, notes };
}

function makeService(host: ExtensionServiceHost): ExtensionService {
  return new ExtensionService({ config: makeConfig(), cwd: projectRoot, host, ui: makeUiDeps() });
}

function writeExtension(name: string, body: string): void {
  writeFileSync(join(extDir, name), body, 'utf-8');
}

/** run() steals the notify sink mid-task; hidden behind a call so TS narrowing doesn't stick. */
function stealNotify(state: ExtensionHostState): void {
  state.notify = undefined;
}

beforeEach(() => {
  globalThis.__extCalls = [];
  projectRoot = mkdtempSync(join(tmpdir(), 'mu-ext-svc-'));
  extDir = join(projectRoot, '.mu-agent', 'extensions');
  mkdirSync(extDir, { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('ExtensionService', () => {
  it('starts with no extensions dir → no runner, host still shared into runs', async () => {
    rmSync(extDir, { recursive: true, force: true });
    const { host } = makeHost(projectRoot);
    const service = makeService(host);
    service.start();
    await service.whenReady();

    const run = service.runExtensions();
    expect(run.runner).toBeUndefined();
    expect(run.host).toBe(service.hostState);
    expect(service.dialogsOpen()).toBe(false);
  });

  it('routes extension slash commands with args', async () => {
    writeExtension(
      'cmd.js',
      `export default function (pi) {
        pi.registerCommand('hello', { description: 't', handler: async (args) => { globalThis.__extCalls.push(['hello', args]); } });
      }`,
    );
    const { host } = makeHost(projectRoot);
    const service = makeService(host);
    service.start();

    await service.handleSlash('/hello wide world');
    expect(globalThis.__extCalls).toEqual([['hello', 'wide world']]);
  });

  it('warns on unknown slash commands', async () => {
    const { host, notes } = makeHost(projectRoot);
    const service = makeService(host);
    service.start();

    await service.handleSlash('/nope');
    expect(notes).toContainEqual({ message: 'unknown command: /nope', level: 'warning' });
  });

  it('/reload re-discovers extensions and reports the count', async () => {
    writeExtension('a.js', `export default function (pi) { pi.on('session_start', () => {}); }`);
    const { host, notes } = makeHost(projectRoot);
    const service = makeService(host);
    service.start();

    await service.handleSlash('/reload');
    expect(notes).toContainEqual({ message: '[extensions] reloaded (1 extension)', level: 'info' });
  });

  it('matches extension shortcuts and fires their handlers', async () => {
    writeExtension(
      'keys.js',
      `export default function (pi) {
        pi.registerShortcut('ctrl+g', { description: 't', handler: () => { globalThis.__extCalls.push('shortcut'); } });
      }`,
    );
    const { host } = makeHost(projectRoot);
    const service = makeService(host);
    service.start();
    await service.whenReady();

    expect(service.matchShortcut('\x08')).toBe(false); // ctrl+h — not registered
    expect(service.matchShortcut('\x07')).toBe(true); // ctrl+g
    await vi.waitFor(() => expect(globalThis.__extCalls).toEqual(['shortcut']));
  });

  it('rejects shortcuts on keys reserved by mu-agent', async () => {
    writeExtension(
      'greedy.js',
      `export default function (pi) {
        pi.registerShortcut('ctrl+c', { description: 't', handler: () => {} });
      }`,
    );
    const { host, notes } = makeHost(projectRoot);
    const service = makeService(host);
    service.start();
    await service.whenReady();

    expect(
      notes.some((n) => n.level === 'warning' && n.message.includes('ctrl+c') && n.message.includes('reserved')),
    ).toBe(true);
    expect(service.matchShortcut('\x03')).toBe(false); // rejected → never registered
  });

  it('surfaces extension load errors as error notifications', async () => {
    writeExtension('broken.js', `throw new Error('boom on load');`);
    const { host, notes } = makeHost(projectRoot);
    const service = makeService(host);
    service.start();
    await service.whenReady();

    expect(notes.some((n) => n.level === 'error' && n.message.includes('broken.js'))).toBe(true);
  });

  it('restoreNotify rebinds the host notify sink after a run stole it', async () => {
    const { host, notes } = makeHost(projectRoot);
    const service = makeService(host);

    stealNotify(service.hostState); // what run() does with the sink
    service.restoreNotify();
    service.hostState.notify?.('back', 'info');
    expect(notes).toContainEqual({ message: 'back', level: 'info' });
  });

  it('enqueued missions flow through the host seam', () => {
    const { host } = makeHost(projectRoot);
    const service = makeService(host);

    service.hostState.enqueueMission?.('do the thing');
    expect(host.enqueueMission).toHaveBeenCalledWith('do the thing');
  });
});
