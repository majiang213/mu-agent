import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui';
import {
  initTheme,
  getMarkdownTheme,
  getSelectListTheme,
  type Theme,
  type ThemeColor,
} from '@earendil-works/pi-coding-agent';
import { State } from '../core/types.js';
import { MU_AGENT_DIR } from '../config/defaults.js';

/** pi's ThemeBg union — not re-exported at the package root in 0.83, declared here. */
type ThemeBg = 'selectedBg' | 'userMessageBg' | 'customMessageBg' | 'toolPendingBg' | 'toolSuccessBg' | 'toolErrorBg';

/**
 * Theme adapter (Gap 87) — mu-agent's hand-rolled ANSI palette is replaced by
 * pi-coding-agent's Theme system (light/dark, user theme files, live switch).
 * The `C` accessor names survive so call sites keep their vocabulary, but
 * every function now resolves through the live pi Theme at call time.
 *
 * State colors are the ONE exception: pi's ThemeColor is a closed token set
 * and the 17-state rainbow is mu-agent's state-machine identity, so they stay
 * a mu-agent palette (hex data + a minimal truecolor helper).
 *
 * Export-map note: pi-coding-agent 0.83's root entrypoint only re-exports
 * initTheme/getMarkdownTheme/getSelectListTheme — the live `theme` proxy,
 * setTheme, theme-file loading and getEditorTheme are NOT exported. The live
 * instance is read through the same globalThis Symbol.for key pi itself uses
 * (their documented cross-loader sharing mechanism); theme-file loading and
 * switching go through ONE dynamic deep import (version-pinned dependency).
 */

const THEME_KEY = Symbol.for('@earendil-works/pi-coding-agent:theme');

/** The deep module surface mu-agent needs beyond the root exports. */
interface PiThemeDeepModule {
  setTheme(name: string, enableWatcher?: boolean): { success: boolean; error?: string };
  loadThemeFromPath(themePath: string): Theme;
  setRegisteredThemes(themes: Theme[]): void;
  getAvailableThemesWithPaths(): Array<{ name: string; path: string | undefined }>;
  getEditorTheme(): EditorTheme;
  getThemeByName(name: string): Theme | undefined;
  setThemeInstance(theme: Theme): void;
}

let initialized = false;
let deepModule: PiThemeDeepModule | null = null;

async function loadDeepModule(): Promise<PiThemeDeepModule | null> {
  if (deepModule) return deepModule;
  try {
    const pkgEntry = import.meta.resolve('@earendil-works/pi-coding-agent');
    const distDir = dirname(fileURLToPath(pkgEntry));
    const mod = (await import(pathToFileURL(join(distDir, 'modes/interactive/theme/theme.js')).href)) as unknown;
    deepModule = mod as PiThemeDeepModule;
    return deepModule;
  } catch (e) {
    console.warn('[theme] pi theme deep module unavailable:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

function liveTheme(): Theme {
  const inst = (globalThis as Record<symbol, unknown>)[THEME_KEY] as Theme | undefined;
  if (!inst) throw new Error('[theme] not initialized — call initMuAgentTheme() first');
  return inst;
}

/** Register mu-agent theme files (~/.mu-agent/themes + <cwd>/.mu-agent/themes) into pi's registry. */
async function registerMuAgentThemes(deep: PiThemeDeepModule): Promise<void> {
  const dirs = [join(homedir(), MU_AGENT_DIR, 'themes'), join(process.cwd(), MU_AGENT_DIR, 'themes')];
  const themes: Theme[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        themes.push(deep.loadThemeFromPath(join(dir, file)));
      } catch (e) {
        console.warn(`[theme] failed to load ${join(dir, file)}:`, e instanceof Error ? e.message : String(e));
      }
    }
  }
  if (themes.length > 0) deep.setRegisteredThemes(themes);
}

/**
 * Initialize the pi theme singleton (idempotent). `themeName` comes from
 * config.theme; undefined = pi default (terminal-background detection).
 * Unknown/invalid names fall back to pi's dark theme silently.
 */
export async function initMuAgentTheme(themeName?: string): Promise<void> {
  if (initialized) return;
  initialized = true;
  const deep = await loadDeepModule();
  if (deep) await registerMuAgentThemes(deep);
  initTheme(themeName);
}

/** Lazy guard for sync accessors — sync fallback init (default theme) if the async init never ran. */
function t(): Theme {
  if (!initialized) {
    initialized = true;
    try {
      initTheme(undefined);
    } catch {
      /* pi falls back to dark internally; propagate only if truly broken */
    }
  }
  return liveTheme();
}

/** Switch theme at runtime (setup wizard picker). */
export async function setMuAgentTheme(name: string): Promise<{ success: boolean; error?: string }> {
  t();
  const deep = await loadDeepModule();
  if (!deep) return { success: false, error: 'theme switching unavailable (pi deep module not found)' };
  return deep.setTheme(name);
}

/** All available themes: pi built-ins + custom dirs + registered mu-agent themes. */
export async function listThemes(): Promise<Array<{ name: string; path: string | undefined }>> {
  t();
  const deep = await loadDeepModule();
  return deep
    ? deep.getAvailableThemesWithPaths()
    : [
        { name: 'dark', path: undefined },
        { name: 'light', path: undefined },
      ];
}

/**
 * Sync theme accessors for the extension UI context (Gap 85-D — pi's
 * ExtensionUIContext theme surface is synchronous). Valid after
 * initMuAgentTheme() has run; before that they degrade to safe defaults.
 */
export function getLiveTheme(): Theme {
  return liveTheme();
}

export function getAllThemesSync(): Array<{ name: string; path: string | undefined }> {
  return (
    deepModule?.getAvailableThemesWithPaths() ?? [
      { name: 'dark', path: undefined },
      { name: 'light', path: undefined },
    ]
  );
}

export function getThemeByNameSync(name: string): Theme | undefined {
  return deepModule?.getThemeByName(name);
}

export function setThemeSync(theme: string | Theme): { success: boolean; error?: string } {
  if (!deepModule) return { success: false, error: 'theme system not initialized' };
  if (typeof theme === 'string') return deepModule.setTheme(theme);
  deepModule.setThemeInstance(theme);
  return { success: true };
}

const fg = (color: ThemeColor) => (s: string) => t().fg(color, s);
const bg = (color: ThemeBg) => (s: string) => t().bg(color, s);

/** Bold passthrough (pi Theme) — kept as a named export for blocks.ts. */
export const bold = (s: string): string => t().bold(s);

export const C = {
  userBar: fg('accent'),
  userText: fg('userMessageText'),
  dim: fg('dim'),
  dimK: fg('dim'),
  dimItalic: (s: string) => t().italic(t().fg('dim', s)),
  divider: fg('borderMuted'),
  toolName: fg('muted'),
  toolArg: fg('accent'),
  ok: fg('success'),
  err: fg('error'),
  pending: fg('muted'),
  headerCwd: fg('muted'),
  headerBranch: fg('success'),
  headerModel: fg('accent'),
  headerSep: fg('borderMuted'),
  headerTokenUp: fg('accent'),
  headerTokenDown: fg('success'),
  headerCtxWarn: fg('warning'),
  headerCtxCrit: fg('error'),
  headerTier: fg('muted'),
  headerProvider: fg('muted'),
  userMsgBg: bg('userMessageBg'),
  toolPendingBg: bg('toolPendingBg'),
  toolSuccessBg: bg('toolSuccessBg'),
  toolErrorBg: bg('toolErrorBg'),
  toolOutput: fg('toolOutput'),
  toolTitle: fg('toolTitle'),
  successText: fg('success'),
  hintKey: fg('muted'),
};

// ── State palette (mu-agent domain — pi ThemeColor is a closed set) ──

/** Minimal truecolor helper for the state rainbow — the only ANSI still owned here. */
function hexBold(hex: string): (s: string) => string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return (s: string) => `\x1b[1m\x1b[38;2;${r};${g};${b}m${s}\x1b[39m\x1b[22m`;
}

/**
 * State → color. Typed as Record<State, ...> so adding a new State member
 * without a color is a compile error (previously it rendered silently dim).
 */
export const STATE_FN: Record<State, (s: string) => string> = {
  [State.LOCATE]: hexBold('#39d353'),
  [State.MODIFY]: hexBold('#d29922'),
  [State.VERIFY]: hexBold('#3fb950'),
  [State.DONE]: hexBold('#3fb950'),
  [State.REASON]: hexBold('#58a6ff'),
  [State.CLARIFY]: hexBold('#ffa64d'),
  [State.ANSWER]: hexBold('#8be9fd'),
  [State.DIAGNOSE]: hexBold('#ff79c6'),
  [State.REVIEW]: hexBold('#bd93f9'),
  [State.TEST_WRITE]: hexBold('#50c8b4'),
  [State.REFACTOR_PLAN]: hexBold('#f1c40f'),
  [State.ROLLBACK]: hexBold('#f85149'),
  [State.RESEARCH]: hexBold('#62d1ff'),
  [State.SETUP]: hexBold('#a0d666'),
  [State.WRITE]: hexBold('#ff91a4'),
  [State.PLAN]: hexBold('#93c5fd'),
  [State.GIT]: hexBold('#e8a87c'),
};

/** Pseudo-states emitted in state_change events that are not State members. */
const PSEUDO_STATE_FN: Record<string, (s: string) => string> = {
  IDLE: C.dim,
  SAMPLING: hexBold('#ffb86c'),
};

export function stateColor(s: string): (t: string) => string {
  return (STATE_FN as Record<string, (s: string) => string>)[s] ?? PSEUDO_STATE_FN[s] ?? C.dim;
}

/** Background-fill a line to `width` with the user-message background token. */
export function fillLine(content: string, width: number): string {
  const padding = ' '.repeat(Math.max(0, width - visibleWidth(content)));
  return t().bg('userMessageBg', content + padding);
}

/** Lazy proxies — the underlying pi theme is resolved per access (live theme switch). */
function lazyThemeObject<T extends object>(getter: () => T): T {
  return new Proxy({} as T, {
    get: (_, prop) => {
      const target = getter();
      const value = target[prop as keyof T];
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export const markdownTheme: MarkdownTheme = lazyThemeObject(() => {
  t();
  return getMarkdownTheme();
});
export const editorTheme: EditorTheme = lazyThemeObject(() => {
  t();
  const deep = deepModule;
  if (deep) return deep.getEditorTheme();
  // Root exports don't include getEditorTheme — derive from the live theme.
  const live = liveTheme();
  return {
    borderColor: (s: string) => live.fg('border', s),
    selectList: {
      selectedPrefix: (s: string) => live.fg('accent', s),
      selectedText: (s: string) => live.bold(s),
      description: (s: string) => live.fg('dim', s),
      scrollInfo: (s: string) => live.fg('dim', s),
      noMatch: (s: string) => live.fg('dim', s),
    },
  };
});
/** SelectList theme — the ONE source (setup wizard, session picker). */
export const selectTheme: SelectListTheme = lazyThemeObject(() => {
  t();
  return getSelectListTheme();
});
