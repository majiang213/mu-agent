import { matchesKey } from '@earendil-works/pi-tui';
import { ModelRegistry } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionCommandContextActions,
  ExtensionContext,
  ExtensionRunner,
  ExtensionUIContext,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';

import { createExtensionHostState } from '../core/extensions/host-actions.js';
import { loadExtensionRunner } from '../core/extensions/loader.js';
import type { ExtensionHostState } from '../core/extensions/host-actions.js';
import { SessionStore } from '../core/session/store.js';
import { reservedKeys } from '../config/keybindings.js';
import { getSharedModelRuntime } from '../provider/model-info.js';
import type { Config } from '../config/types.js';
import { createExtensionUI } from './extension-ui.js';
import type { ExtensionUIDeps } from './extension-ui.js';

/**
 * Narrow seam into TuiApp — extension-service.ts never imports app.ts
 * (mirrors extension-ui.ts's ExtensionUIDeps discipline).
 */
export interface ExtensionServiceHost {
  /** One-line notification into the scrollback. */
  notify(message: string, level: 'info' | 'warning' | 'error'): void;
  /** Idle-time delivery target for pi.sendUserMessage (Gap 85-D). */
  enqueueMission(text: string): void;
  /** True while a task run is active (session switch/fork defer to idle). */
  isBusy(): boolean;
  /** Swap the live session (extension newSession/fork/switchSession). */
  switchSessionStore(store: SessionStore): void;
  /** The live session manager (fork reads it; the runner binds it at load). */
  sessionManager(): SessionManager;
  /** Current model getter for the extension context (Gap 85-C). */
  currentModel(): Model<'openai-completions'> | undefined;
  /** Extension pi.setModel entry point — queues mid-run, applies idle. */
  requestModelSwitch(modelId: string, provider: string): boolean;
}

export interface ExtensionServiceOptions {
  config: Config;
  cwd: string;
  host: ExtensionServiceHost;
  /** UI wiring minus dialogOpenChanged — the dialog counter lives here. */
  ui: Omit<ExtensionUIDeps, 'dialogOpenChanged'>;
}

/**
 * ExtensionService — the long-lived extension layer (architecture review
 * 2026-08-05, candidate 3). One home for everything Gap 85-D left inside
 * TuiApp: the one-per-app runner lifecycle (init/reload), ExtensionHostState,
 * the ExtensionUIContext, slash routing, shortcut matching, and the dialog
 * counter that gates the global key listener. TuiApp keeps what it owns —
 * keys, editor, session persistence, model switching — and reaches all of
 * this through the ExtensionServiceHost seam.
 *
 * Deletion test: removing this module would scatter ~250 lines of extension
 * plumbing back across TuiApp's constructor, key listener, and submit path.
 */
export class ExtensionService {
  /** Shared into each run via runExtensions() (one per app, not per run). */
  readonly hostState: ExtensionHostState = createExtensionHostState();
  private readonly host: ExtensionServiceHost;
  private readonly config: Config;
  private readonly cwd: string;
  private readonly uiDeps: Omit<ExtensionUIDeps, 'dialogOpenChanged'>;
  private readonly ui: ExtensionUIContext;
  private runner: ExtensionRunner | undefined;
  private shortcuts = new Map<
    Parameters<typeof matchesKey>[1],
    { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void }
  >();
  private ready: Promise<unknown> = Promise.resolve();
  private dialogsOpenCount = 0;

  constructor(options: ExtensionServiceOptions) {
    this.config = options.config;
    this.cwd = options.cwd;
    this.host = options.host;
    this.uiDeps = options.ui;
    this.ui = createExtensionUI({
      ...options.ui,
      dialogOpenChanged: (delta) => {
        this.dialogsOpenCount = Math.max(0, this.dialogsOpenCount + delta);
      },
    });
    this.hostState.notify = (message, level) => this.host.notify(message, level);
    this.hostState.enqueueMission = (text) => this.host.enqueueMission(text);
  }

  /** Kick off the one-per-app extension load (call once, from TuiApp.start). */
  start(): void {
    this.ready = this.init();
  }

  /** Awaited before slash commands and runs touch the runner. */
  whenReady(): Promise<unknown> {
    return this.ready;
  }

  /** While a dialog/overlay is open the global key listener must yield. */
  dialogsOpen(): boolean {
    return this.dialogsOpenCount > 0;
  }

  /** The pair agent.run() shares via options.extensions (Gap 85-D). */
  runExtensions(): { runner: ExtensionRunner | undefined; host: ExtensionHostState } {
    return { runner: this.runner, host: this.hostState };
  }

  /**
   * run() reassigns the notify sink to its own event stream — restore the
   * TUI line path so idle-time extension notifications still render.
   */
  restoreNotify(): void {
    this.hostState.notify = (message, level) => this.host.notify(message, level);
  }

  /** Load + bind the ONE extension runner. */
  private async init(): Promise<ExtensionRunner | undefined> {
    try {
      const runtime = await getSharedModelRuntime();
      const registry = new ModelRegistry(runtime);
      const { runner, errors } = await loadExtensionRunner(
        this.config,
        this.cwd,
        this.hostState,
        () => this.host.currentModel(),
        registry,
        this.host.sessionManager(),
        {
          registerProvider: (name, pcfg) => runtime.registerProvider(name, pcfg),
          registerNativeProvider: (p) => runtime.registerNativeProvider(p),
          unregisterProvider: (name) => runtime.unregisterProvider(name),
        },
        (modelId, provider) => this.host.requestModelSwitch(modelId, provider),
      );
      this.runner = runner;
      for (const err of errors) this.host.notify(`[extensions] failed to load: ${err}`, 'error');
      if (runner) {
        runner.setUIContext(this.ui, 'tui');
        runner.bindCommandContext(this.buildCommandContextActions());
      }
      this.refreshShortcuts();
      return runner;
    } catch (err) {
      this.host.notify(`[extensions] init failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return undefined;
    }
  }

  /** Command-context actions: session lifecycle for extension slash commands. */
  private buildCommandContextActions(): ExtensionCommandContextActions {
    const busy = (): boolean => {
      if (this.host.isBusy()) {
        this.host.notify('[extensions] session switch/fork is unavailable mid-task', 'warning');
        return true;
      }
      return false;
    };
    return {
      waitForIdle: async () => {
        while (this.host.isBusy()) await new Promise((r) => setTimeout(r, 50));
      },
      newSession: async () => {
        if (busy()) return { cancelled: true };
        this.host.switchSessionStore(SessionStore.create(this.cwd));
        return { cancelled: false };
      },
      fork: async (entryId: string) => {
        if (busy()) return { cancelled: true };
        const path = this.host.sessionManager().createBranchedSession(entryId);
        if (!path) return { cancelled: true };
        this.host.switchSessionStore(SessionStore.open(path, this.cwd));
        return { cancelled: false };
      },
      navigateTree: async () => {
        this.host.notify('[extensions] navigateTree is not supported in mu-agent', 'warning');
        return { cancelled: true };
      },
      switchSession: async (sessionPath: string) => {
        if (busy()) return { cancelled: true };
        this.host.switchSessionStore(SessionStore.open(sessionPath, this.cwd));
        return { cancelled: false };
      },
      reload: async () => {
        await this.reload();
      },
    };
  }

  /** Rebuild the shortcut map from the runner, rejecting keys reserved by mu-agent (Gap 85-D). */
  private refreshShortcuts(): void {
    this.shortcuts.clear();
    const runner = this.runner;
    if (!runner) return;
    const reserved = reservedKeys(this.uiDeps.keybindings);
    for (const [keyId, shortcut] of runner.getShortcuts({})) {
      if (reserved.has(keyId.toLowerCase())) {
        this.host.notify(`[extensions] shortcut ${keyId} rejected: reserved by mu-agent`, 'warning');
        continue;
      }
      this.shortcuts.set(keyId, shortcut);
    }
  }

  /** /reload: invalidate the current runner and re-discover extensions. */
  async reload(): Promise<void> {
    this.runner?.invalidate('reload');
    this.runner = undefined;
    this.shortcuts.clear();
    const runner = await this.init();
    const count = runner?.getExtensionPaths().length ?? 0;
    this.host.notify(`[extensions] reloaded (${count} extension${count === 1 ? '' : 's'})`, 'info');
  }

  /** Slash routing (Gap 85-D): /reload builtin, then extension commands. */
  async handleSlash(input: string): Promise<void> {
    const spaceIdx = input.indexOf(' ');
    const name = (spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx)).toLowerCase();
    const args = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1).trim();
    await this.whenReady();
    if (name === 'reload') {
      await this.reload();
      return;
    }
    const runner = this.runner;
    const cmd = runner?.getCommand(name);
    if (!runner || !cmd) {
      this.host.notify(`unknown command: /${name}`, 'warning');
      return;
    }
    try {
      await cmd.handler(args, runner.createCommandContext());
    } catch (err) {
      this.host.notify(`/${name} failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
    this.uiDeps.tui.requestRender(true);
  }

  /**
   * Fire an extension shortcut if the key matches one. The TuiApp listener
   * calls this AFTER its own built-ins; reserved keys were already rejected
   * at registration. True = consumed.
   */
  matchShortcut(data: string): boolean {
    for (const [keyId, shortcut] of this.shortcuts) {
      if (matchesKey(data, keyId)) {
        const runner = this.runner;
        if (runner) {
          void Promise.resolve(shortcut.handler(runner.createContext())).catch((err) => {
            this.host.notify(
              `[extensions] shortcut ${keyId} failed: ${err instanceof Error ? err.message : String(err)}`,
              'error',
            );
          });
        }
        return true;
      }
    }
    return false;
  }
}
