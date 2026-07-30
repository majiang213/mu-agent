import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

export interface SessionHeader {
  type: 'header';
  cwd: string;
  created: number;
  version?: number;
}

export interface SessionMessage {
  type: 'message';
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export type SessionEntry = SessionHeader | SessionMessage;

export interface SessionInfo {
  filePath: string;
  created: number;
  preview: string;
}

/** Session files are line-delimited JSON — the extension says so (legacy
 *  .json files are still read for backward compatibility). */
const SESSION_EXT = '.jsonl';
const LEGACY_EXT = '.json';

function getSessionsDir(projectRoot: string, create: boolean): string {
  const dir = join(projectRoot, '.mu-agent', 'sessions');
  if (create && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function formatTimestamp(ts: number): string {
  const tsStr = new Date(ts).toISOString().slice(0, 19).replace(/:/g, '-').replace(' ', 'T') + 'Z';
  const suffix = randomBytes(4).toString('hex');
  return `${tsStr}_${suffix}`;
}

function parseEntries(filePath: string): SessionEntry[] {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  const entries: SessionEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      // ignore malformed lines
    }
  }
  return entries;
}

/** Newest first: filenames start with an ISO timestamp, so name order IS
 *  chronological order (a single ordering — no mtime fallback). */
function sessionFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(SESSION_EXT) || f.endsWith(LEGACY_EXT))
      .sort()
      .reverse()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export class SessionStore {
  private _isEmpty = true;
  private _writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    readonly filePath: string,
    private readonly projectRoot: string,
  ) {
    this._isEmpty = !existsSync(filePath);
  }

  get isEmpty(): boolean {
    return this._isEmpty;
  }

  static create(projectRoot: string): SessionStore {
    const dir = getSessionsDir(projectRoot, true);
    const ts = formatTimestamp(Date.now());
    const filePath = join(dir, `${ts}${SESSION_EXT}`);
    return new SessionStore(filePath, projectRoot);
  }

  static openLatest(projectRoot: string): SessionStore | null {
    const dir = getSessionsDir(projectRoot, false);
    const latest = findLatestSession(dir);
    if (!latest) return null;
    return new SessionStore(latest, projectRoot);
  }

  static open(filePath: string, projectRoot: string): SessionStore {
    return new SessionStore(filePath, projectRoot);
  }

  static list(projectRoot: string): SessionInfo[] {
    const dir = getSessionsDir(projectRoot, false);
    return listSessions(dir);
  }

  append(msg: SessionMessage): Promise<void> {
    const op = this._writeQueue.then(async () => {
      if (this._isEmpty) {
        const header: SessionHeader = {
          type: 'header',
          cwd: this.projectRoot,
          created: Date.now(),
          version: 1,
        };
        await writeFile(this.filePath, `${JSON.stringify(header)}\n${JSON.stringify(msg)}\n`);
        this._isEmpty = false;
        return;
      }
      await appendFile(this.filePath, `${JSON.stringify(msg)}\n`);
    });
    // The chain absorbs failures so one failed append cannot poison every
    // later append; the CALLER still sees this append's real rejection.
    this._writeQueue = op.catch((err) => {
      console.error('[session] write failed:', err instanceof Error ? err.message : err);
    });
    return op;
  }

  load(): AgentMessage[] {
    try {
      const entries = parseEntries(this.filePath);
      return entries
        .filter((e): e is SessionMessage => e.type === 'message')
        .map(
          (e) =>
            ({
              role: e.role,
              content: e.content,
              timestamp: e.timestamp,
            }) as AgentMessage,
        );
    } catch {
      return [];
    }
  }
}

function findLatestSession(dir: string): string | null {
  for (const filePath of sessionFiles(dir)) {
    try {
      const firstLine = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean)[0];
      if (!firstLine) continue;
      const header = JSON.parse(firstLine) as SessionEntry;
      if (header.type === 'header') return filePath;
    } catch {
      // unreadable file — keep looking
    }
  }
  return null;
}

function listSessions(dir: string): SessionInfo[] {
  const infos: SessionInfo[] = [];
  for (const filePath of sessionFiles(dir)) {
    try {
      const entries = parseEntries(filePath);
      const header = entries.find((e): e is SessionHeader => e.type === 'header');
      if (!header) continue;
      const firstUserMsg = entries.find((e): e is SessionMessage => e.type === 'message' && e.role === 'user');
      const preview = firstUserMsg ? firstUserMsg.content.slice(0, 50) : '(empty)';
      infos.push({ filePath, created: header.created, preview });
    } catch {
      // ignore unreadable files
    }
  }
  return infos;
}
