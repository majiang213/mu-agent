import type { Agent } from '@earendil-works/pi-agent-core';
import type { ExtensionContextActions, ExtensionActions, SessionManager } from '@earendil-works/pi-coding-agent';

/**
 * Live host state the extension runtime consults at call time (Gap 85-A).
 * Shared by reference across the whole run; builder/step-runner update it,
 * the bound ExtensionContextActions read it. Per-step RunConfig spreads all
 * carry the same reference.
 */
export interface ExtensionHostState {
  /** Live step agents — ctx.abort() / pi.shutdown() fan out here. */
  agents: Set<Agent>;
  /** Last system prompt handed to a step agent (ctx.getSystemPrompt). */
  systemPrompt: string;
  /** TUI sink for extension notifications/errors (assigned by the run loop). */
  notify?: (message: string, level: 'info' | 'warning' | 'error') => void;
  /**
   * Idle-time mission sink (Gap 85-D): pi.sendUserMessage with no running
   * agent queues the text as the TUI's next task. Assigned by the TUI.
   */
  enqueueMission?: (text: string) => void;
}

export function createExtensionHostState(): ExtensionHostState {
  return { agents: new Set(), systemPrompt: '' };
}

/**
 * ExtensionActions for mu-agent runs. Session-tree actions (appendEntry /
 * session name / labels) are REAL since Gap 85-B — they write into the run's
 * own pi SessionManager, shared with the TUI's SessionStore. The interactive
 * surface (sendMessage delivery, thinking level) lands with 85-D — those
 * remain no-ops that warn once, so a pi extension written against the full
 * API degrades instead of exploding.
 */
export function buildExtensionActions(
  warn: (msg: string) => void,
  host: ExtensionHostState,
  sessionManager: SessionManager,
  onModelSwitchRequest?: (modelId: string, provider: string) => boolean,
): ExtensionActions {
  const unsupported = (name: string) => () =>
    warn(`[extensions] pi.${name}() is not supported yet (lands with Gap 85-D)`);
  return {
    sendMessage: unsupported('sendMessage'),
    // Gap 85-D: real delivery — mid-run steers the active step agent (pi
    // steer semantics), idle queues the text as the TUI's next mission.
    sendUserMessage: (content) => {
      const text =
        typeof content === 'string'
          ? content
          : content
              .filter((c) => c.type === 'text')
              .map((c) => c.text)
              .join('\n');
      const active = [...host.agents].at(-1);
      if (active) {
        active.steer({ role: 'user', content: text, timestamp: Date.now() });
      } else if (host.enqueueMission) {
        host.enqueueMission(text);
      } else {
        warn('[extensions] pi.sendUserMessage() has no delivery channel in this run');
      }
    },
    // Gap 85-B: real session-tree writes against the run's SessionManager.
    appendEntry: (customType, data) => {
      sessionManager.appendCustomEntry(customType, data);
    },
    setSessionName: (name) => {
      sessionManager.appendSessionInfo(name);
    },
    getSessionName: () => sessionManager.getSessionName(),
    setLabel: (entryId, label) => {
      sessionManager.appendLabelChange(entryId, label);
    },
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: unsupported('setActiveTools'),
    refreshTools: () => {},
    getCommands: () => [],
    // Gap 85-C: real model switch — queued mid-run, applied at run end.
    setModel: (model) => {
      const accepted = onModelSwitchRequest?.(model.id, model.provider) ?? false;
      if (!accepted) warn('[extensions] pi.setModel() has no switch channel in this run');
      return Promise.resolve(accepted);
    },
    getThinkingLevel: () => 'off',
    setThinkingLevel: unsupported('setThinkingLevel'),
  };
}

/**
 * Context actions resolved against the live host state. abort/shutdown hit
 * every registered step agent; compact is a no-op because mu-agent owns a
 * step-level compaction policy pi's session-level trigger cannot express.
 */
export function buildExtensionContextActions(
  host: ExtensionHostState,
  getModel: ExtensionContextActions['getModel'],
): ExtensionContextActions {
  return {
    getModel,
    getScopedModels: () => [],
    isIdle: () => host.agents.size === 0,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => {
      for (const agent of host.agents) agent.abort();
    },
    hasPendingMessages: () => false,
    shutdown: () => {
      for (const agent of host.agents) agent.abort();
    },
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => host.systemPrompt,
  };
}
