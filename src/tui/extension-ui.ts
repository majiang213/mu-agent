import { Container, Editor, Input, SelectList, Text } from '@earendil-works/pi-tui';
import type {
  Component,
  Focusable,
  KeybindingsManager,
  OverlayHandle,
  OverlayOptions,
  TUI,
} from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
  KeybindingsManager as CodingAgentKeybindings,
  WorkingIndicatorOptions,
} from '@earendil-works/pi-coding-agent';
import {
  C,
  bold,
  editorTheme,
  selectTheme,
  getLiveTheme,
  getAllThemesSync,
  getThemeByNameSync,
  setThemeSync,
} from './theme.js';

/**
 * Real ExtensionUIContext for mu-agent's TUI (Gap 85-D) — replaces 85-A's
 * noOpUIContext (hasUI=false). Dialogs mount as pi-tui overlays; widgets and
 * statuses render in zones the TuiApp exposes through the deps seam; the
 * theme surface delegates to Gap 87's sync accessors.
 *
 * Honest degradation (warn-once, not silent): setEditorComponent live-swap,
 * addAutocompleteProvider, and the working-loader knobs (setWorkingVisible /
 * setWorkingIndicator / setHiddenThinkingLabel) — mu-agent's loader/editor are
 * not extension-configurable beyond what the deps expose.
 *
 * Keybindings cast note: pi's ExtensionUIContext types the custom() factory's
 * keybindings param as coding-agent's KeybindingsManager SUBCLASS (adds
 * configPath/reload/getEffectiveConfig). mu-agent's Gap 88 manager is the
 * pi-tui base class — same matching surface — so custom() passes it through
 * ONE documented cast.
 */

/** Narrow seam into TuiApp — extension-ui.ts never imports app.ts. */
export interface ExtensionUIDeps {
  tui: TUI;
  editor: Editor;
  keybindings: KeybindingsManager;
  /** One-line notification into the scrollback (the extension_notify path). */
  notifyLine: (message: string, type: 'info' | 'warning' | 'error') => void;
  warn: (message: string) => void;
  insertAboveEditor: (component: Component) => void;
  insertBelowEditor: (component: Component) => void;
  removeComponent: (component: Component) => void;
  /** Swap the header/footer component; undefined restores the built-in. */
  replaceHeader: (component: (Component & { dispose?(): void }) | undefined) => void;
  replaceFooter: (component: (Component & { dispose?(): void }) | undefined) => void;
  getToolsExpanded: () => boolean;
  setToolsExpanded: (expanded: boolean) => void;
  /** Loader text swap while a run streams (RunView owns the loader). */
  setWorkingMessage?: (message?: string) => void;
  /**
   * Dialog open/close signal — while > 0 the TuiApp's global key listener
   * must yield (Escape cancels the dialog, not the run; pi-tui global
   * listeners fire before the focused overlay).
   */
  dialogOpenChanged: (delta: 1 | -1) => void;
}

/**
 * Container that forwards keys to one interactive child and can cancel on
 * Escape (pi-tui's Editor has no escape hook; overlays focus the component
 * they are given, so the Escape branch must live here).
 */
class FocusDelegate extends Container implements Focusable {
  focused = false;
  onEscape?: () => void;
  constructor(
    private readonly target: Component & { handleInput?(data: string): void },
    title?: string,
  ) {
    super();
    if (title) this.addChild(new Text(bold(' ' + title), 0, 0));
    this.addChild(target);
  }
  handleInput(data: string): void {
    if (data === '\x1b' && this.onEscape) {
      this.onEscape();
      return;
    }
    this.target.handleInput?.(data);
  }
}

export function createExtensionUI(deps: ExtensionUIDeps): ExtensionUIContext {
  const { tui } = deps;
  const warned = new Set<string>();
  const warnOnce = (name: string, msg: string): void => {
    if (warned.has(name)) return;
    warned.add(name);
    deps.warn(msg);
  };

  /** Shared dialog lifecycle: overlay + signal/timeout dismissal + settle-once. */
  function runDialog<T>(
    body: Component & { handleInput?(data: string): void },
    title: string,
    opts: ExtensionUIDialogOptions | undefined,
    cancelValue: T,
    wire: (box: FocusDelegate, done: (value: T) => void) => void,
  ): Promise<T> {
    return new Promise((resolve) => {
      const box = new FocusDelegate(body, title);
      const handle = tui.showOverlay(box, { width: '60%', maxHeight: '50%', anchor: 'center' });
      deps.dialogOpenChanged(1);
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (value: T): void => {
        if (settled) return;
        settled = true;
        deps.dialogOpenChanged(-1);
        if (timer) clearTimeout(timer);
        opts?.signal?.removeEventListener('abort', onAbort);
        handle.hide();
        tui.requestRender();
        resolve(value);
      };
      const onAbort = (): void => done(cancelValue);
      box.onEscape = () => done(cancelValue);
      if (opts?.signal?.aborted) {
        handle.hide();
        resolve(cancelValue);
        return;
      }
      opts?.signal?.addEventListener('abort', onAbort);
      if (opts?.timeout && opts.timeout > 0) timer = setTimeout(() => done(cancelValue), opts.timeout);
      wire(box, done);
    });
  }

  // Widget + status zones live here (TuiApp only provides insert/remove).
  const widgets = new Map<string, { component: Component & { dispose?(): void } }>();
  const statuses = new Map<string, string>();
  let statusLine: Text | null = null;

  function renderStatusLine(): void {
    const text = [...statuses.values()].join('  ');
    if (!text) {
      if (statusLine) {
        deps.removeComponent(statusLine);
        statusLine = null;
      }
    } else if (statusLine) {
      statusLine.setText(C.dim('  ' + text));
    } else {
      statusLine = new Text(C.dim('  ' + text), 0, 0);
      deps.insertBelowEditor(statusLine);
    }
    tui.requestRender();
  }

  let editorFactory: ReturnType<ExtensionUIContext['getEditorComponent']>;

  return {
    select(title, options, opts) {
      const list = new SelectList(
        options.map((o) => ({ value: o, label: o })),
        Math.min(10, Math.max(1, options.length)),
        selectTheme,
      );
      return runDialog<string | undefined>(list, title, opts, undefined, (_box, done) => {
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(undefined);
      });
    },

    confirm(title, message, opts) {
      const list = new SelectList(
        [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ],
        2,
        selectTheme,
      );
      return runDialog<boolean>(list, `${title} — ${message}`, opts, false, (_box, done) => {
        list.onSelect = (item) => done(item.value === 'yes');
        list.onCancel = () => done(false);
      });
    },

    input(title, placeholder, opts) {
      const field = new Input();
      return runDialog<string | undefined>(
        field,
        placeholder ? `${title} (${placeholder})` : title,
        opts,
        undefined,
        (_box, done) => {
          field.onSubmit = (value) => done(value);
          field.onEscape = () => done(undefined);
        },
      );
    },

    editor(title, prefill) {
      const ed = new Editor(tui, editorTheme, { paddingX: 1 });
      if (prefill) ed.setText(prefill);
      return new Promise<string | undefined>((resolve) => {
        const box = new FocusDelegate(ed, title);
        const handle = tui.showOverlay(box, { width: '80%', maxHeight: '60%', anchor: 'center' });
        deps.dialogOpenChanged(1);
        let settled = false;
        const done = (value: string | undefined): void => {
          if (settled) return;
          settled = true;
          deps.dialogOpenChanged(-1);
          handle.hide();
          tui.requestRender();
          resolve(value);
        };
        box.onEscape = () => done(undefined);
        ed.onSubmit = (value) => done(value);
      });
    },

    notify(message, type) {
      deps.notifyLine(message, type ?? 'info');
    },

    onTerminalInput(handler) {
      return tui.addInputListener((data) => handler(data));
    },

    setStatus(key, text) {
      if (text === undefined) statuses.delete(key);
      else statuses.set(key, text);
      renderStatusLine();
    },

    setWorkingMessage(message) {
      if (deps.setWorkingMessage) deps.setWorkingMessage(message);
      else warnOnce('setWorkingMessage', '[extensions] ui.setWorkingMessage() has no loader in this view');
    },
    setWorkingVisible() {
      warnOnce('setWorkingVisible', '[extensions] ui.setWorkingVisible() is not configurable in mu-agent');
    },
    setWorkingIndicator(_options?: WorkingIndicatorOptions) {
      warnOnce('setWorkingIndicator', '[extensions] ui.setWorkingIndicator() is not configurable in mu-agent');
    },
    setHiddenThinkingLabel() {
      warnOnce('setHiddenThinkingLabel', '[extensions] ui.setHiddenThinkingLabel() is not configurable in mu-agent');
    },

    setWidget(key, content, options?: ExtensionWidgetOptions) {
      const existing = widgets.get(key);
      if (existing) {
        existing.component.dispose?.();
        deps.removeComponent(existing.component);
        widgets.delete(key);
      }
      if (content === undefined) {
        tui.requestRender();
        return;
      }
      const component =
        typeof content === 'function'
          ? content(tui, getLiveTheme())
          : new Text(content.map((l) => C.dim('  ' + l)).join('\n'), 0, 0);
      widgets.set(key, { component });
      if (options?.placement === 'belowEditor') deps.insertBelowEditor(component);
      else deps.insertAboveEditor(component);
      tui.requestRender();
    },

    setFooter(factory) {
      // FooterDataProvider: pi exposes git branch + extension statuses; the
      // statuses map is ours, the branch detector is mu-agent's own.
      deps.replaceFooter(
        factory
          ? factory(tui, getLiveTheme(), { gitBranch: undefined, extensionStatuses: statuses } as never)
          : undefined,
      );
      tui.requestRender();
    },

    setHeader(factory) {
      deps.replaceHeader(factory ? factory(tui, getLiveTheme()) : undefined);
      tui.requestRender();
    },

    setTitle(title) {
      process.stdout.write(`\x1b]0;${title}\x07`);
    },

    custom<T>(
      factory: (
        tui: TUI,
        theme: Theme,
        keybindings: CodingAgentKeybindings,
        done: (result: T) => void,
      ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
      options?: {
        overlay?: boolean;
        overlayOptions?: OverlayOptions | (() => OverlayOptions);
        onHandle?: (handle: OverlayHandle) => void;
      },
    ): Promise<T> {
      return new Promise<T>((resolve) => {
        let handle: OverlayHandle | null = null;
        let component: (Component & { dispose?(): void }) | null = null;
        deps.dialogOpenChanged(1);
        const done = (result: T): void => {
          deps.dialogOpenChanged(-1);
          component?.dispose?.();
          if (handle) handle.hide();
          else if (component) deps.removeComponent(component);
          tui.setFocus(deps.editor);
          tui.requestRender();
          resolve(result);
        };
        void Promise.resolve(
          factory(tui, getLiveTheme(), deps.keybindings as unknown as CodingAgentKeybindings, done),
        ).then((c) => {
          component = c;
          if (options?.overlay === false) {
            deps.insertAboveEditor(c);
            tui.setFocus(c as Component & Focusable);
          } else {
            const overlayOpts =
              typeof options?.overlayOptions === 'function' ? options.overlayOptions() : options?.overlayOptions;
            handle = tui.showOverlay(c, overlayOpts ?? { width: '80%', maxHeight: '70%', anchor: 'center' });
            options?.onHandle?.(handle);
          }
        });
      });
    },

    pasteToEditor(text) {
      deps.editor.insertTextAtCursor(text);
      tui.requestRender();
    },
    setEditorText(text) {
      deps.editor.setText(text);
      tui.requestRender();
    },
    getEditorText() {
      return deps.editor.getText();
    },

    addAutocompleteProvider() {
      warnOnce(
        'addAutocompleteProvider',
        '[extensions] ui.addAutocompleteProvider() is not wired into the mu-agent editor',
      );
    },

    setEditorComponent(factory) {
      editorFactory = factory;
      warnOnce('setEditorComponent', '[extensions] ui.setEditorComponent() live-swap is not supported in mu-agent');
    },
    getEditorComponent() {
      return editorFactory;
    },

    get theme(): Theme {
      return getLiveTheme();
    },
    getAllThemes() {
      return getAllThemesSync();
    },
    getTheme(name) {
      return getThemeByNameSync(name);
    },
    setTheme(theme) {
      return setThemeSync(theme);
    },

    getToolsExpanded() {
      return deps.getToolsExpanded();
    },
    setToolsExpanded(expanded) {
      deps.setToolsExpanded(expanded);
    },
  };
}
