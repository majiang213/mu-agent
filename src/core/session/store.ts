import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import { MU_AGENT_DIR } from '../../config/defaults.js';

export interface SessionMessage {
  type: 'message';
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface SessionInfo {
  filePath: string;
  created: number;
  preview: string;
}

function sessionsDir(projectRoot: string): string {
  return join(projectRoot, MU_AGENT_DIR, 'sessions');
}

/**
 * Session persistence — thin adapter over pi-coding-agent's SessionManager
 * (Gap 85-B). The append-only tree, id/parentId linking, compaction-aware
 * context building, and file naming are all pi's; this class keeps only
 * mu-agent's call-site surface (create/openLatest/open/list/append/load).
 *
 * Legacy mu-agent linear JSONL files (header type "header") are RETIRED, not
 * migrated: they stay on disk but pi's discovery only reads its own format
 * (header type "session"), so old files simply stop appearing in list/resume.
 */
export class SessionStore {
  private constructor(
    /** The real pi SessionManager — handed to the extension runner per run. */
    readonly manager: SessionManager,
    private readonly projectRoot: string,
  ) {}

  /** Session file path. Set at create() even before the first append writes it. */
  get filePath(): string | undefined {
    return this.manager.getSessionFile();
  }

  /** True while the active branch holds no entries (fresh session). */
  get isEmpty(): boolean {
    return this.manager.getBranch().length === 0;
  }

  static create(projectRoot: string): SessionStore {
    return new SessionStore(SessionManager.create(projectRoot, sessionsDir(projectRoot)), projectRoot);
  }

  static openLatest(projectRoot: string): SessionStore | null {
    // Reads stay read-only: pi's continueRecent mkdirs the session dir in its
    // ctor, so bail out before constructing when there is nothing to read.
    if (!existsSync(sessionsDir(projectRoot))) return null;
    const manager = SessionManager.continueRecent(projectRoot, sessionsDir(projectRoot));
    // continueRecent assigns a fresh (unwritten) sessionFile when the dir has
    // no pi sessions — only an on-disk file counts as "found".
    const file = manager.getSessionFile();
    if (!file || !existsSync(file)) return null;
    return new SessionStore(manager, projectRoot);
  }

  static open(filePath: string, projectRoot: string): SessionStore {
    return new SessionStore(SessionManager.open(filePath, sessionsDir(projectRoot)), projectRoot);
  }

  static async list(projectRoot: string): Promise<SessionInfo[]> {
    const infos = await SessionManager.list(projectRoot, sessionsDir(projectRoot));
    return infos.map((i) => ({
      filePath: i.path,
      created: i.created.getTime(),
      preview: i.firstMessage ? i.firstMessage.slice(0, 50) : '(empty)',
    }));
  }

  /** Append a user/assistant message as child of the current leaf (sync write, async signature kept for call sites). */
  append(msg: SessionMessage): Promise<void> {
    // Single-point cast: mu-agent persists duck-typed {role, content, timestamp}
    // messages (presenter.assistantMessageForSession), which pi stores verbatim
    // and returns untouched on load — the roundtrip is exact.
    const message = { role: msg.role, content: msg.content, timestamp: msg.timestamp } as unknown as Parameters<
      SessionManager['appendMessage']
    >[0];
    this.manager.appendMessage(message);
    return Promise.resolve();
  }

  /** Messages on the active branch, root → leaf. */
  load(): AgentMessage[] {
    return this.manager
      .getBranch()
      .filter((e): e is SessionMessageEntry => e.type === 'message')
      .map((e) => e.message as AgentMessage);
  }
}
