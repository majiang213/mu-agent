import { Editor, Loader, ProcessTerminal, Text, TUI, matchesKey } from '@earendil-works/pi-tui';
import type { Component, KeybindingsManager, OverlayHandle } from '@earendil-works/pi-tui';
import { ModelRegistry, ModelSelectorComponent } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionCommandContextActions,
  ExtensionContext,
  ExtensionRunner,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import { homedir } from 'node:os';

import { ReactAgent } from '../core/agent/index.js';
import { tierForParams } from '../core/agent/state-machine.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { MetricsCollector } from './metrics.js';
import { C, stateColor, editorTheme } from './theme.js';
import { createMuKeybindings, keyLabel, reservedKeys } from '../config/keybindings.js';
import { saveConfig } from '../config/loader.js';
import { DEFAULT_CONTEXT_RATIO } from '../config/defaults.js';
import { buildModels, getSharedModelRuntime } from '../provider/model-info.js';
import { createExtensionHostState, loadExtensionRunner } from '../core/extensions/index.js';
import type { ExtensionHostState } from '../core/extensions/index.js';
import { createExtensionUI } from './extension-ui.js';
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { formatRunResult, formatTaskSummary, assistantMessageForSession, stripLegacyPrefixes } from './presenter.js';
import { isAbortError } from '../core/agent/abort.js';
import type { Config } from '../config/types.js';
import { getLspStatuses } from '../tool/lsp-status.js';
import { SessionStore } from '../core/session/store.js';
import { detectGitBranch, HeaderLine, HintLine, UserMessage } from './blocks.js';
import { RunView } from './run-view.js';
import type { RunViewHost } from './run-view.js';

export interface TuiAppOptions {
  config: Config;
  sessionStore?: SessionStore;
}

/**
 * TuiApp — terminal orchestration shell: editor/loader lifecycle, keybindings,
 * submit pipeline, session persistence. View classes live in blocks.ts,
 * per-run event handling in run-view.ts (behind the RunViewHost seam),
 * formatting in presenter.ts (third-pass review, candidate 9).
 */
export class TuiApp {
  private tui: TUI;
  private editor: Editor;
  private header: HeaderLine;
  private hintLine: HintLine;
  private keybindings: KeybindingsManager;
  private metrics = new MetricsCollector();
  private running = false;
  private debugMode = false;
  private conversationHistory: AgentMessage[] = [];
  private sessionStore: SessionStore;
  private currentAgent: ReactAgent | null = null;
  private pendingClarificationAgent: ReactAgent | null = null;
  private runView: RunView | null = null;
  /** Model switch requested mid-run (extension pi.setModel) — applied at run end (Gap 85-C). */
  private pendingModelSwitch: { modelId: string; provider: string } | null = null;
  private modelSelectorOpen = false;
  // Gap 85-D: long-lived extension layer (one runner per app, not per run).
  private extensionHost: ExtensionHostState = createExtensionHostState();
  private extensionRunner: ExtensionRunner | undefined;
  private extensionUI: ExtensionUIContext;
  private extensionShortcuts = new Map<
    Parameters<typeof matchesKey>[1],
    { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void }
  >();
  private extensionsReady: Promise<unknown> = Promise.resolve();
  private extensionDialogsOpen = 0;
  private missionQueue: string[] = [];
  private currentModel: Model<'openai-completions'> | undefined;
  private activeHeader: (Component & { dispose?(): void }) | null = null;
  private activeFooter: (Component & { dispose?(): void }) | null = null;
  private _sigwinchHandler = (): void => {
    try {
      this.tui.requestRender(true);
    } catch {
      // ignore render errors during terminal resize
    }
  };

  constructor(private options: TuiAppOptions) {
    const terminal = new ProcessTerminal();
    this.tui = new TUI(terminal);

    const home = homedir();
    const rawCwd = process.cwd();
    const cwdDisplay = rawCwd.startsWith(home) ? '~' + rawCwd.slice(home.length) : rawCwd;
    this.header = new HeaderLine(options.config.model.name, cwdDisplay, detectGitBranch());
    this.keybindings = createMuKeybindings();
    this.hintLine = new HintLine({
      quit: keyLabel(this.keybindings, 'app.exit'),
      interrupt: keyLabel(this.keybindings, 'app.interrupt'),
      thinking: keyLabel(this.keybindings, 'app.thinking.toggle'),
      tools: keyLabel(this.keybindings, 'app.tools.expand'),
      debug: keyLabel(this.keybindings, 'app.debug.toggle'),
    });

    {
      const provider = options.config.model.provider;
      const modelSize = options.config.model.modelSize;
      // Tier thresholds have one home (state-machine.ts); lowercase only at
      // this presentation edge.
      const tier = modelSize != null ? tierForParams(modelSize).toLowerCase() : '';
      this.header.setProviderInfo(provider, tier, 0);
    }

    if (options.sessionStore) {
      this.sessionStore = options.sessionStore;
      // Legacy sessions persisted assistant messages with a presentation
      // prefix; strip it so it doesn't flow back into the model's context.
      this.conversationHistory = stripLegacyPrefixes(options.sessionStore.load());
    } else {
      this.sessionStore = SessionStore.create(process.cwd());
    }

    this.editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
    this.editor.onSubmit = (value) => this.handleSubmit(value);

    this.tui.addInputListener((data) => {
      // Extension dialog/overlay open → the focused component owns all keys
      // (pi-tui global listeners fire first; Esc must cancel the dialog, not abort).
      if (this.extensionDialogsOpen > 0) return undefined;
      if (data === '\x03' || this.keybindings.matches(data, 'app.exit')) {
        this.stop();
        return { consume: true };
      }
      if (this.keybindings.matches(data, 'app.interrupt')) {
        if (this.currentAgent) {
          this.currentAgent.abort();
        }
        return { consume: true };
      }
      if (this.keybindings.matches(data, 'app.thinking.toggle')) {
        // Toggle policy lives in the RunView view-model (round-5, candidate 4).
        if (this.runView?.toggleThinking()) this.tui.requestRender(true);
        return { consume: true };
      }
      if (this.keybindings.matches(data, 'app.tools.expand')) {
        if (this.runView?.toggleTools()) this.tui.requestRender(true);
        return { consume: true };
      }
      if (this.keybindings.matches(data, 'app.debug.toggle')) {
        this.debugMode = !this.debugMode;
        this.hintLine.setDebugMode(this.debugMode);
        this.runView?.setDebugVisible(this.debugMode);
        this.tui.requestRender(true);
        return { consume: true };
      }
      if (this.keybindings.matches(data, 'app.model.select')) {
        // Idle only — mid-run switches come from extensions via setModel and queue.
        if (!this.currentAgent) void this.openModelSelector();
        return { consume: true };
      }
      // Extension shortcuts (Gap 85-D) — after built-ins, reserved keys already rejected at registration.
      for (const [keyId, shortcut] of this.extensionShortcuts) {
        if (matchesKey(data, keyId)) {
          const runner = this.extensionRunner;
          if (runner) {
            void Promise.resolve(shortcut.handler(runner.createContext())).catch((err) => {
              this.notifyLine(
                `[extensions] shortcut ${keyId} failed: ${err instanceof Error ? err.message : String(err)}`,
                'error',
              );
            });
          }
          return { consume: true };
        }
      }
      return undefined;
    });

    this.tui.addChild(this.editor);
    this.tui.addChild(this.header);
    this.tui.addChild(this.hintLine);

    // Gap 85-D: the extension UI context is built once against live TUI
    // pieces; the runner it attaches to arrives in initExtensions().
    this.extensionUI = createExtensionUI({
      tui: this.tui,
      editor: this.editor,
      keybindings: this.keybindings,
      notifyLine: (message, type) => this.notifyLine(message, type),
      warn: (msg) => this.notifyLine(msg, 'warning'),
      insertAboveEditor: (c) => this.insertBefore(c),
      insertBelowEditor: (c) => {
        const idx = this.tui.children.indexOf(this.editor);
        this.tui.children.splice(idx + 1, 0, c);
      },
      removeComponent: (c) => this.tui.removeChild(c),
      replaceHeader: (c) => this.swapZone('header', c),
      replaceFooter: (c) => this.swapZone('footer', c),
      getToolsExpanded: () => this.runView?.toolsExpanded ?? false,
      setToolsExpanded: (v) => {
        this.runView?.setToolsExpanded(v);
        this.tui.requestRender(true);
      },
      dialogOpenChanged: (delta) => {
        this.extensionDialogsOpen = Math.max(0, this.extensionDialogsOpen + delta);
      },
    });
    this.extensionHost.notify = (message, level) => this.notifyLine(message, level);
    this.extensionHost.enqueueMission = (text) => this.enqueueMission(text);
  }

  start(): void {
    this.running = true;

    process.on('SIGINT', () => this.stop());
    process.on('SIGWINCH', this._sigwinchHandler);
    this.tui.setFocus(this.editor);
    this.tui.start();

    // Gap 85-D: long-lived extension layer (slash commands/shortcuts/dialogs work idle).
    this.extensionsReady = this.initExtensions();

    for (const s of getLspStatuses(process.cwd())) {
      if (s.lspStatus === 'not_installed') {
        this.insertBefore(new Text(C.err(`  ✗ LSP: ${s.lspServer} not installed (run mu-agent setup)`), 0, 0));
      }
    }

    this.insertBefore(new Text(C.dim('  Ready — type a task and press Enter'), 0, 0));
    this.tui.requestRender();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    process.off('SIGWINCH', this._sigwinchHandler);
    this.tui.stop();
    process.exit(0);
  }

  private insertBefore(component: Component): void {
    const idx = this.tui.children.indexOf(this.editor);
    this.tui.children.splice(idx, 0, component);
  }

  /** One-line extension notification into the scrollback. */
  private notifyLine(message: string, level: 'info' | 'warning' | 'error'): void {
    const icon = level === 'error' ? C.err('  ✗ ') : level === 'warning' ? C.dim('  ⚠ ') : C.dim('  ℹ ');
    this.insertBefore(new Text(icon + C.dim(message), 0, 0));
    this.tui.requestRender();
  }

  /** Header/footer injection points (Gap 85-D): swap a zone's component, restore on undefined. */
  private swapZone(kind: 'header' | 'footer', component?: Component & { dispose?(): void }): void {
    const builtin = kind === 'header' ? this.header : this.hintLine;
    const active = kind === 'header' ? this.activeHeader : this.activeFooter;
    const current = active ?? builtin;
    if (active && active !== component) active.dispose?.();
    const idx = this.tui.children.indexOf(current);
    if (idx >= 0) this.tui.children.splice(idx, 1);
    const next = component ?? builtin;
    this.tui.children.splice(Math.max(0, idx), 0, next);
    if (kind === 'header') this.activeHeader = component ?? null;
    else this.activeFooter = component ?? null;
    this.tui.requestRender(true);
  }

  /**
   * Load + bind the app's ONE extension runner (Gap 85-D). Extensions load
   * once per app lifetime; the runner is shared into each run via options.
   */
  private async initExtensions(): Promise<ExtensionRunner | undefined> {
    try {
      const runtime = await getSharedModelRuntime();
      const registry = new ModelRegistry(runtime);
      const { runner, errors } = await loadExtensionRunner(
        this.options.config,
        process.cwd(),
        this.extensionHost,
        () => this.currentModel,
        registry,
        this.sessionStore.manager,
        {
          registerProvider: (name, pcfg) => runtime.registerProvider(name, pcfg),
          registerNativeProvider: (p) => runtime.registerNativeProvider(p),
          unregisterProvider: (name) => runtime.unregisterProvider(name),
        },
        (modelId, provider) => this.requestModelSwitch(modelId, provider),
      );
      this.extensionRunner = runner;
      for (const err of errors) this.notifyLine(`[extensions] failed to load: ${err}`, 'error');
      if (runner) {
        runner.setUIContext(this.extensionUI, 'tui');
        runner.bindCommandContext(this.buildCommandContextActions());
      }
      this.refreshExtensionShortcuts();
      return runner;
    } catch (err) {
      this.notifyLine(`[extensions] init failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return undefined;
    }
  }

  /** Command-context actions: session lifecycle for extension slash commands. */
  private buildCommandContextActions(): ExtensionCommandContextActions {
    const busy = (): boolean => {
      if (this.currentAgent) {
        this.notifyLine('[extensions] session switch/fork is unavailable mid-task', 'warning');
        return true;
      }
      return false;
    };
    return {
      waitForIdle: async () => {
        while (this.currentAgent) await new Promise((r) => setTimeout(r, 50));
      },
      newSession: async () => {
        if (busy()) return { cancelled: true };
        this.switchSessionStore(SessionStore.create(process.cwd()));
        return { cancelled: false };
      },
      fork: async (entryId: string) => {
        if (busy()) return { cancelled: true };
        const path = this.sessionStore.manager.createBranchedSession(entryId);
        if (!path) return { cancelled: true };
        this.switchSessionStore(SessionStore.open(path, process.cwd()));
        return { cancelled: false };
      },
      navigateTree: async () => {
        this.notifyLine('[extensions] navigateTree is not supported in mu-agent', 'warning');
        return { cancelled: true };
      },
      switchSession: async (sessionPath: string) => {
        if (busy()) return { cancelled: true };
        this.switchSessionStore(SessionStore.open(sessionPath, process.cwd()));
        return { cancelled: false };
      },
      reload: async () => {
        await this.reloadExtensions();
      },
    };
  }

  private switchSessionStore(store: SessionStore): void {
    this.sessionStore = store;
    this.conversationHistory = stripLegacyPrefixes(store.load());
    this.notifyLine(`  session → ${store.filePath ?? '(new)'}`, 'info');
  }

  /** Rebuild the shortcut map from the runner, rejecting keys reserved by mu-agent (Gap 85-D). */
  private refreshExtensionShortcuts(): void {
    this.extensionShortcuts.clear();
    const runner = this.extensionRunner;
    if (!runner) return;
    const reserved = reservedKeys(this.keybindings);
    for (const [keyId, shortcut] of runner.getShortcuts({})) {
      if (reserved.has(keyId.toLowerCase())) {
        this.notifyLine(`[extensions] shortcut ${keyId} rejected: reserved by mu-agent`, 'warning');
        continue;
      }
      this.extensionShortcuts.set(keyId, shortcut);
    }
  }

  /** /reload: invalidate the current runner and re-discover extensions. */
  private async reloadExtensions(): Promise<void> {
    this.extensionRunner?.invalidate('reload');
    this.extensionRunner = undefined;
    this.extensionShortcuts.clear();
    const runner = await this.initExtensions();
    const count = runner?.getExtensionPaths().length ?? 0;
    this.notifyLine(`[extensions] reloaded (${count} extension${count === 1 ? '' : 's'})`, 'info');
  }

  /** Slash command routing (Gap 85-D): /reload builtin, then extension commands. */
  private async handleSlashCommand(input: string): Promise<void> {
    const spaceIdx = input.indexOf(' ');
    const name = (spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx)).toLowerCase();
    const args = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1).trim();
    await this.extensionsReady;
    if (name === 'reload') {
      await this.reloadExtensions();
      return;
    }
    const runner = this.extensionRunner;
    const cmd = runner?.getCommand(name);
    if (!runner || !cmd) {
      this.notifyLine(`unknown command: /${name}`, 'warning');
      return;
    }
    try {
      await cmd.handler(args, runner.createCommandContext());
    } catch (err) {
      this.notifyLine(`/${name} failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
    this.tui.requestRender(true);
  }

  /** Idle-time delivery target for pi.sendUserMessage (Gap 85-D). */
  private enqueueMission(text: string): void {
    this.missionQueue.push(text);
    this.notifyLine(`queued task: ${text.length > 60 ? text.slice(0, 60) + '…' : text}`, 'info');
    this.drainMissionQueue();
  }

  private drainMissionQueue(): void {
    if (this.currentAgent || this.missionQueue.length === 0) return;
    const next = this.missionQueue.shift()!;
    void this.handleSubmit(next);
  }

  /**
   * Extension pi.setModel entry point (Gap 85-C). Mid-run requests queue and
   * apply in handleSubmit's tail; idle requests apply immediately. Always
   * returns true — the switch is accepted, just possibly deferred.
   */
  private requestModelSwitch(modelId: string, provider: string): boolean {
    if (this.currentAgent) {
      this.pendingModelSwitch = { modelId, provider };
      this.insertBefore(new Text(C.dim(`  ⏳ model switch queued → ${modelId} (applies after this task)`), 0, 0));
      this.tui.requestRender();
    } else {
      void this.applyModelSwitch(modelId, provider);
    }
    return true;
  }

  private async applyModelSwitch(modelId: string, provider: string): Promise<void> {
    if (provider !== this.options.config.model.provider) {
      this.insertBefore(
        new Text(
          C.err(
            `  ✗ provider switch not supported (requested ${provider}, current ${this.options.config.model.provider})`,
          ),
          0,
          0,
        ),
      );
      this.tui.requestRender();
      return;
    }
    this.options.config.model.name = modelId;
    try {
      saveConfig({ model: { ...this.options.config.model, name: modelId } });
    } catch (err) {
      console.error('[TuiApp] failed to persist model switch:', err);
    }
    this.header.setModel(modelId);
    this.insertBefore(new Text(C.dim(`  ➤ model → ${modelId} (tier/context re-probe on next task)`), 0, 0));
    this.tui.requestRender();
  }

  private async openModelSelector(): Promise<void> {
    if (this.modelSelectorOpen) return;
    this.modelSelectorOpen = true;
    try {
      const cfg = this.options.config;
      const runtime = await getSharedModelRuntime();
      if (runtime.getRegisteredProviderIds().length === 0) {
        // No run has happened yet — register the configured provider so the
        // selector has a catalog (refreshModels pulls the live list).
        await buildModels(
          cfg.model.name,
          cfg.model.provider,
          cfg.model.baseUrl,
          cfg.model.contextRatio ?? DEFAULT_CONTEXT_RATIO,
          cfg.model.apiKey,
        );
      }
      // The component persists defaults via SettingsManager; mu-agent persists
      // through saveConfig in applyModelSwitch, so the manager is a stub
      // (single-point cast, same pattern as the extensions SessionManager).
      const settingsStub = { setDefaultModelAndProvider: () => {} } as unknown as SettingsManager;
      let handle: OverlayHandle | null = null;
      const close = (): void => {
        handle?.hide();
        handle = null;
        this.modelSelectorOpen = false;
        this.tui.setFocus(this.editor);
        this.tui.requestRender();
      };
      const selector = new ModelSelectorComponent(
        this.tui,
        runtime.getModel(cfg.model.provider, cfg.model.name),
        settingsStub,
        runtime,
        [],
        (model) => {
          close();
          void this.applyModelSwitch(model.id, model.provider);
        },
        close,
      );
      handle = this.tui.showOverlay(selector, { width: '80%', maxHeight: '70%', anchor: 'center' });
    } catch (err) {
      this.modelSelectorOpen = false;
      this.insertBefore(
        new Text(C.err(`  ✗ model selector: ${err instanceof Error ? err.message : String(err)}`), 0, 0),
      );
      this.tui.requestRender();
    }
  }

  /**
   * Append the turn to history + session store. The SessionMessage →
   * AgentMessage boundary casts are contained HERE (previously three inline
   * copies across the success and catch paths).
   */
  private async persistTurn(input: string, display?: string): Promise<void> {
    const ts = Date.now();
    const userMsg = { role: 'user' as const, content: input, timestamp: ts };
    this.conversationHistory.push(userMsg as AgentMessage);
    await this.sessionStore.append({ type: 'message', ...userMsg });
    if (display) {
      const assistantMsg = assistantMessageForSession(display, ts + 1);
      this.conversationHistory.push(assistantMsg as unknown as AgentMessage);
      await this.sessionStore.append({ type: 'message', ...assistantMsg });
    }
  }

  private async handleSubmit(value: string): Promise<void> {
    const input = value.trim();
    if (!input) return;

    // Slash commands (Gap 85-D) never reach the agent or the session history.
    if (input.startsWith('/')) {
      await this.handleSlashCommand(input);
      return;
    }

    this.editor.disableSubmit = true;
    this.editor.addToHistory(input);
    this.header.resetTaskStats();
    this.insertBefore(new UserMessage(input));
    this.tui.requestRender();

    if (this.pendingClarificationAgent) {
      const agent = this.pendingClarificationAgent;
      this.pendingClarificationAgent = null;
      this.editor.disableSubmit = false;
      agent.provideClarification(input);
      return;
    }

    const taskId = `task-${Date.now()}`;
    this.header.setState('REASON');

    const loader = new Loader(
      this.tui,
      (s) => stateColor(this.runView?.loaderState ?? 'REASON')(s),
      (s) => C.dim(s),
      'running...',
    );
    this.insertBefore(loader);

    const host: RunViewHost = {
      insertBeforeLoader: (component) => {
        const idx = this.tui.children.indexOf(loader);
        this.tui.children.splice(idx, 0, component);
      },
      insertBeforeEditor: (component) => this.insertBefore(component),
      removeComponent: (component) => {
        this.tui.removeChild(component);
      },
      requestRender: () => this.tui.requestRender(),
    };
    const runView = new RunView({
      host,
      header: this.header,
      loader,
      metrics: this.metrics,
      taskId,
      isDebugMode: () => this.debugMode,
      onClarification: () => {
        this.pendingClarificationAgent = this.currentAgent;
        this.editor.disableSubmit = false;
      },
    });
    this.runView = runView;
    loader.start();
    this.tui.requestRender();

    this.metrics.startTask(taskId);

    const agent = new ReactAgent();
    this.currentAgent = agent;
    let aborted = false;
    let threw = false;
    try {
      await this.extensionsReady;
      const result = await agent.run(input, this.options.config, runView.handleEvent, this.conversationHistory, {
        onModelSwitchRequest: (modelId, provider) => this.requestModelSwitch(modelId, provider),
        // Gap 85-B: extension session actions land in the SAME session the TUI persists to.
        sessionManager: this.sessionStore.manager,
        // Gap 85-D: the app's long-lived runner+host (per-run load only when absent).
        extensions: { runner: this.extensionRunner, host: this.extensionHost },
        onModelBuilt: (model) => {
          this.currentModel = model;
        },
      });
      loader.stop();
      this.tui.removeChild(loader);
      runView.dispose();
      this.metrics.finishTask(taskId, result.success);

      const display = formatRunResult(result.output);
      if (display) {
        this.insertBefore(new Text(display, 0, 0));
      }

      try {
        await this.persistTurn(input, display);
      } catch (persistErr) {
        console.error('[TuiApp] session persistence failed:', persistErr);
      }
    } catch (err) {
      try {
        loader.stop();
        this.tui.removeChild(loader);
      } catch {
        /* cleanup best-effort */
      }
      try {
        runView.dispose();
      } catch {
        /* cleanup best-effort */
      }
      try {
        await this.persistTurn(input);
      } catch (persistErr) {
        console.error('[TuiApp] session persistence failed in catch:', persistErr);
      }
      if (isAbortError(err)) {
        aborted = true;
        this.metrics.finishTask(taskId, false);
        this.insertBefore(new Text(C.dim('  ⊘  interrupted'), 0, 0));
      } else {
        threw = true;
        this.metrics.finishTask(taskId, false);
        this.insertBefore(new Text(C.err(`  ✗  error: ${String(err)}`), 0, 0));
      }
    } finally {
      this.currentAgent = null;
      this.runView = null;
      // run() reassigns the notify sink to its own event stream — restore the
      // TUI line path so idle-time extension notifications still render.
      this.extensionHost.notify = (message, level) => this.notifyLine(message, level);
    }

    // Deferred model switch (extension pi.setModel during the run) — apply now
    // that the agent is idle (Gap 85-C).
    if (this.pendingModelSwitch) {
      const { modelId, provider } = this.pendingModelSwitch;
      this.pendingModelSwitch = null;
      await this.applyModelSwitch(modelId, provider);
    }

    const m = this.metrics.getMetrics(taskId);
    if (m) {
      const { status, stats } = formatTaskSummary(m);
      if (m.success) {
        this.insertBefore(new Text('\n' + C.successText(status) + C.dim(stats), 0, 0));
      } else if (!aborted && !threw) {
        this.insertBefore(new Text('\n' + C.err(status) + C.dim(stats), 0, 0));
      }
    }
    this.header.setState('IDLE');
    this.editor.disableSubmit = false;
    this.tui.requestRender();
    this.drainMissionQueue();
  }
}

export function createTuiApp(options: TuiAppOptions): TuiApp {
  return new TuiApp(options);
}
