import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TUI_KEYBINDINGS, KeybindingsManager } from '@earendil-works/pi-tui';
import type { KeybindingDefinitions, KeybindingsConfig } from '@earendil-works/pi-tui';
import { MU_AGENT_DIR } from './defaults.js';

/**
 * mu-agent app keybindings — the ONE definitions source (Gap 88).
 *
 * Built on pi-tui's KeybindingsManager (matching/collision detection/user
 * overrides), NOT pi-coding-agent's KeybindingsManager.create(): that one
 * freezes pi's 40+ app actions (session tree, model picker — mu-agent has
 * none of those) and binds ctrl+d to app.exit, which collides with
 * mu-agent's debug toggle. mu-agent curates its own app.* actions on top of
 * the shared tui.* editor/select bindings.
 */
export interface MuAppKeybindings {
  'app.exit': true;
  'app.interrupt': true;
  'app.thinking.toggle': true;
  'app.tools.expand': true;
  'app.debug.toggle': true;
  'app.model.select': true;
}

declare module '@earendil-works/pi-tui' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging requires an interface body (same pattern pi-coding-agent uses)
  interface Keybindings extends MuAppKeybindings {}
}

export const MU_KEYBINDINGS: KeybindingDefinitions = {
  ...TUI_KEYBINDINGS,
  'app.exit': { defaultKeys: 'ctrl+c', description: 'Quit mu-agent' },
  'app.interrupt': { defaultKeys: 'escape', description: 'Abort the running task' },
  'app.thinking.toggle': { defaultKeys: 'ctrl+t', description: 'Toggle thinking blocks' },
  'app.tools.expand': { defaultKeys: 'ctrl+o', description: 'Toggle tool output' },
  'app.debug.toggle': { defaultKeys: 'ctrl+d', description: 'Toggle debug mode' },
  'app.model.select': { defaultKeys: 'ctrl+l', description: 'Open model selector' },
};

/**
 * Reserved actions (Gap 85-D): extension registerShortcut must reject keys
 * already bound to these — the harness's control surface is not for sale.
 */
export const MU_RESERVED_ACTIONS = [
  'app.exit',
  'app.interrupt',
  'app.thinking.toggle',
  'app.tools.expand',
  'app.debug.toggle',
] as const;

const KEYBINDINGS_FILENAME = 'keybindings.json';

/** Tolerant user-override load: malformed JSON or wrong shape → no overrides. */
function loadUserBindings(agentDir: string): KeybindingsConfig {
  const path = join(agentDir, KEYBINDINGS_FILENAME);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as KeybindingsConfig;
  } catch (e) {
    console.warn(`[keybindings] failed to parse ${path}:`, e instanceof Error ? e.message : String(e));
    return {};
  }
}

/** Create the mu-agent keybindings manager (defaults + ~/.mu-agent/keybindings.json overrides). */
export function createMuKeybindings(agentDir: string = join(homedir(), MU_AGENT_DIR)): KeybindingsManager {
  return new KeybindingsManager(MU_KEYBINDINGS, loadUserBindings(agentDir));
}

/**
 * Keys currently bound to reserved actions — extension registerShortcut must
 * not claim these (Gap 85-D; user overrides included, so a remapped reserved
 * action stays protected).
 */
export function reservedKeys(manager: KeybindingsManager): Set<string> {
  const keys = new Set<string>();
  for (const action of MU_RESERVED_ACTIONS) {
    for (const key of manager.getKeys(action)) keys.add(key.toLowerCase());
  }
  return keys;
}

/** Display label for an action's first key, e.g. 'ctrl+c' → 'Ctrl+C', 'escape' → 'Esc'. */
export function keyLabel(manager: KeybindingsManager, action: Parameters<KeybindingsManager['getKeys']>[0]): string {
  const first = manager.getKeys(action)[0] ?? '';
  return first
    .split('+')
    .map((part) => {
      if (part === 'ctrl') return 'Ctrl';
      if (part === 'alt') return 'Alt';
      if (part === 'shift') return 'Shift';
      if (part === 'escape') return 'Esc';
      return part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1);
    })
    .join('+');
}
