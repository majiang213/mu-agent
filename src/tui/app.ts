import { Editor, Loader, ProcessTerminal, Text, TUI } from '@earendil-works/pi-tui';
import type { Component, KeybindingsManager, OverlayHandle } from '@earendil-works/pi-tui';
import { ModelSelectorComponent } from '@earendil-works/pi-coding-agent';
import type { SettingsManager } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import { execSync } from 'node:child_process';

import { ReactAgent } from '../core/agent/index.js';
import { tierForParams } from '../core/agent/state-machine.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { C, stateColor, editorTheme, notifyIcon } from './theme.js';
import { createMuKeybindings, keyLabel } from '../config/keybindings.js';
import { saveConfig } from '../config/loader.js';
import { collapseHome } from '../config/paths.js';
import { buildModels, getSharedModelRuntime } from '../provider/model-info.js';
import { ExtensionService } from './extension-service.js';
import { formatRunResult, formatTaskSummary, assistantMessageForSession, stripLegacyPrefixes } from './presenter.js';
import { isAbortError } from '../core/agent/abort.js';
import type { Config } from '../config/types.js';
import { getLspStatuses } from '../tool/lsp-status.js';
import { SessionStore } from '../core/session/store.js';
import { HeaderLine, HintLine, UserMessage } from './blocks.js';
import { RunView } from './run-view.js';
import type { RunViewHost } from './run-view.js';

export interface TuiAppOptions {
  config: Config;
  sessionStore?: SessionStore;
}

/** Best-effort current git branch ('' outside a repo or on error). Shell-side
 * I/O — the HeaderLine view just receives the string (round-7 hygiene). */
function detectGitBranch(): string {
  try {
    return execSync('git branch --show-current', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
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
  // Gap 85-D / architecture C3: the long-lived extension layer (one runner
  // per app, slash, shortcuts, dialogs) lives behind the ExtensionService seam.
  private extensions: ExtensionService;
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

    this.header = new HeaderLine(options.config.model.name, collapseHome(process.cwd()), detectGitBranch());
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
      // Tier thresholds have one home (state-machine.ts); HeaderLine owns
      // the lowercase presentation normalization.
      const tier = modelSize != null ? tierForParams(modelSize) : '';
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
      if (this.extensions.dialogsOpen()) return undefined;
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
      if (this.extensions.matchShortcut(data)) return { consume: true };
      return undefined;
    });

    this.tui.addChild(this.editor);
    this.tui.addChild(this.header);
    this.tui.addChild(this.hintLine);

    // Gap 85-D / architecture C3: the extension layer is built once against
    // live TUI pieces; the runner it loads is shared into each run.
    this.extensions = new ExtensionService({
      config: options.config,
      cwd: process.cwd(),
      host: {
        notify: (message, level) => this.notifyLine(message, level),
        enqueueMission: (text) => this.enqueueMission(text),
        isBusy: () => this.currentAgent !== null,
        switchSessionStore: (store) => this.switchSessionStore(store),
        sessionManager: () => this.sessionStore.manager,
        currentModel: () => this.currentModel,
        requestModelSwitch: (modelId, provider) => this.requestModelSwitch(modelId, provider),
      },
      ui: {
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
      },
    });
  }

  start(): void {
    this.running = true;

    process.on('SIGINT', () => this.stop());
    process.on('SIGWINCH', this._sigwinchHandler);
    this.tui.setFocus(this.editor);
    this.tui.start();

    // Gap 85-D: long-lived extension layer (slash commands/shortcuts/dialogs work idle).
    this.extensions.start();

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
    this.insertBefore(new Text('  ' + notifyIcon(level) + ' ' + C.dim(message), 0, 0));
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

  private switchSessionStore(store: SessionStore): void {
    this.sessionStore = store;
    this.conversationHistory = stripLegacyPrefixes(store.load());
    this.notifyLine(`  session → ${store.filePath ?? '(new)'}`, 'info');
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
      saveConfig({ model: { ...this.options.config.model } });
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
        await buildModels(cfg.model);
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
    this.sessionStore.append({ type: 'message', ...userMsg });
    if (display) {
      const assistantMsg = assistantMessageForSession(display, ts + 1);
      this.conversationHistory.push(assistantMsg as unknown as AgentMessage);
      this.sessionStore.append({ type: 'message', ...assistantMsg });
    }
  }

  private async handleSubmit(value: string): Promise<void> {
    const input = value.trim();
    if (!input) return;

    // Slash commands (Gap 85-D) never reach the agent or the session history.
    if (input.startsWith('/')) {
      await this.extensions.handleSlash(input);
      return;
    }

    this.editor.disableSubmit = true;
    this.editor.addToHistory(input);
    this.insertBefore(new UserMessage(input));
    this.tui.requestRender();

    if (this.pendingClarificationAgent) {
      const agent = this.pendingClarificationAgent;
      this.pendingClarificationAgent = null;
      this.editor.disableSubmit = false;
      agent.provideClarification(input);
      return;
    }

    // New task starts HERE — resetting stats any earlier zeroes the in-flight
    // run's counters when the input is a clarification answer (R8-B2).
    this.header.resetTaskStats();
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
      isDebugMode: () => this.debugMode,
      onClarification: () => {
        this.pendingClarificationAgent = this.currentAgent;
        this.editor.disableSubmit = false;
      },
    });
    this.runView = runView;
    loader.start();
    this.tui.requestRender();

    const agent = new ReactAgent();
    this.currentAgent = agent;
    let aborted = false;
    let threw = false;
    let succeeded = false;
    try {
      await this.extensions.whenReady();
      const result = await agent.run(input, this.options.config, runView.handleEvent, this.conversationHistory, {
        onModelSwitchRequest: (modelId, provider) => this.requestModelSwitch(modelId, provider),
        // Gap 85-B: extension session actions land in the SAME session the TUI persists to.
        sessionManager: this.sessionStore.manager,
        // Gap 85-D: the app's long-lived runner+host (per-run load only when absent).
        extensions: this.extensions.runExtensions(),
        onModelBuilt: (model) => {
          this.currentModel = model;
        },
      });
      loader.stop();
      this.tui.removeChild(loader);
      runView.dispose();
      succeeded = result.success;

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
        this.insertBefore(new Text(C.dim('  ⊘  interrupted'), 0, 0));
      } else {
        threw = true;
        this.insertBefore(new Text(C.err(`  ✗  error: ${String(err)}`), 0, 0));
      }
    } finally {
      this.currentAgent = null;
      this.runView = null;
      // run() reassigns the notify sink to its own event stream — restore the
      // TUI line path so idle-time extension notifications still render.
      this.extensions.restoreNotify();
    }

    // Deferred model switch (extension pi.setModel during the run) — apply now
    // that the agent is idle (Gap 85-C).
    if (this.pendingModelSwitch) {
      const { modelId, provider } = this.pendingModelSwitch;
      this.pendingModelSwitch = null;
      await this.applyModelSwitch(modelId, provider);
    }

    // Summary from the one run-stats accumulator (HeaderLine, round-7 C8) —
    // real usage tokens, not the deleted collector's chars÷4 underestimate.
    const runStats = this.header.taskStats();
    const { status, stats } = formatTaskSummary({
      success: succeeded,
      llmCalls: runStats.llmCalls,
      totalTokens: runStats.totalTokens,
    });
    if (succeeded) {
      this.insertBefore(new Text('\n' + C.successText(status) + C.dim(stats), 0, 0));
    } else if (!aborted && !threw) {
      this.insertBefore(new Text('\n' + C.err(status) + C.dim(stats), 0, 0));
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
