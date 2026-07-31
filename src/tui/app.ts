import { Editor, Loader, matchesKey, ProcessTerminal, Text, TUI } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import { homedir } from 'node:os';

import { ReactAgent } from '../core/agent/index.js';
import { tierForParams } from '../core/agent/state-machine.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { MetricsCollector } from './metrics.js';
import { C, stateColor, editorTheme } from './theme.js';
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
  private metrics = new MetricsCollector();
  private running = false;
  private debugMode = false;
  private conversationHistory: AgentMessage[] = [];
  private sessionStore: SessionStore;
  private currentAgent: ReactAgent | null = null;
  private pendingClarificationAgent: ReactAgent | null = null;
  private runView: RunView | null = null;
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
    this.hintLine = new HintLine();

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
      if (data === '\x03' || matchesKey(data, 'ctrl+c')) {
        this.stop();
        return { consume: true };
      }
      if (data === '\x1b') {
        if (this.currentAgent) {
          this.currentAgent.abort();
        }
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+t')) {
        const thinkingExpandables = [...(this.runView?.thinkingBlocks ?? []), ...(this.runView?.sampleTurns ?? [])];
        if (thinkingExpandables.length > 0) {
          const anyExpanded = thinkingExpandables.some((b) => b.expanded);
          for (const b of thinkingExpandables) b.setExpanded(!anyExpanded);
          this.tui.requestRender(true);
        }
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+o')) {
        const toolExpandables = this.runView?.toolBlocks ?? [];
        if (toolExpandables.length > 0) {
          const anyExpanded = toolExpandables.some((b) => b.expanded);
          for (const b of toolExpandables) b.setExpanded(!anyExpanded);
          this.tui.requestRender(true);
        }
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+d')) {
        this.debugMode = !this.debugMode;
        this.hintLine.setDebugMode(this.debugMode);
        for (const b of this.runView?.debugBlocks ?? []) {
          b.setVisible(this.debugMode);
          b.setExpanded(this.debugMode);
        }
        this.tui.requestRender(true);
        return { consume: true };
      }
      return undefined;
    });

    this.tui.addChild(this.editor);
    this.tui.addChild(this.header);
    this.tui.addChild(this.hintLine);
  }

  start(): void {
    this.running = true;

    process.on('SIGINT', () => this.stop());
    process.on('SIGWINCH', this._sigwinchHandler);
    this.tui.setFocus(this.editor);
    this.tui.start();

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
      const result = await agent.run(input, this.options.config, runView.handleEvent, this.conversationHistory);
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
  }
}

export function createTuiApp(options: TuiAppOptions): TuiApp {
  return new TuiApp(options);
}
