import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

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

function getSessionsDir(projectRoot: string): string {
  const dir = join(projectRoot, '.mu-agent', 'sessions');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().slice(0, 19).replace(/:/g, '-').replace(' ', 'T') + 'Z';
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

export class SessionStore {
  private _isEmpty = true;

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
    const dir = getSessionsDir(projectRoot);
    const ts = formatTimestamp(Date.now());
    const filePath = join(dir, `${ts}.json`);
    return new SessionStore(filePath, projectRoot);
  }

  static openLatest(projectRoot: string): SessionStore | null {
    const dir = getSessionsDir(projectRoot);
    const latest = findLatestSession(dir);
    if (!latest) return null;
    return new SessionStore(latest, projectRoot);
  }

  static open(filePath: string, projectRoot: string): SessionStore {
    return new SessionStore(filePath, projectRoot);
  }

  static list(projectRoot: string): SessionInfo[] {
    const dir = getSessionsDir(projectRoot);
    return listSessions(dir);
  }

  async append(msg: SessionMessage): Promise<void> {
    if (this._isEmpty) {
      const header: SessionHeader = {
        type: 'header',
        cwd: this.projectRoot,
        created: Date.now(),
        version: 1,
      };
      writeFileSync(this.filePath, `${JSON.stringify(header)}\n`);
      this._isEmpty = false;
    }
    await appendFile(this.filePath, `${JSON.stringify(msg)}\n`);
  }

  load(): AgentMessage[] {
    const entries = parseEntries(this.filePath);
    const header = entries.find((e): e is SessionHeader => e.type === 'header');
    if (header && header.version !== undefined && header.version !== 1) {
      console.warn('[session] Schema version:', header.version, '(current: 1)');
    }
    return entries
      .filter((e): e is SessionMessage => e.type === 'message')
      .map(
        (e) =>
          ({
            role: 'user',
            content: e.content,
            timestamp: e.timestamp,
          }) as AgentMessage,
      );
  }
}

function findLatestSession(dir: string): string | null {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => join(dir, f))
      .filter((p) => {
        try {
          const lines = readFileSync(p, 'utf-8').split('\n').filter(Boolean);
          if (lines.length === 0) return false;
          const header = JSON.parse(lines[0]!) as SessionEntry;
          return header.type === 'header';
        } catch {
          return false;
        }
      })
      .sort((a, b) => statSync(b).mtime.getTime() - statSync(a).mtime.getTime());
    return files[0] ?? null;
  } catch {
    return null;
  }
}

function listSessions(dir: string): SessionInfo[] {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(b).mtime.getTime() - statSync(a).mtime.getTime());

    const infos: SessionInfo[] = [];
    for (const filePath of files) {
      try {
        const entries = parseEntries(filePath);
        const header = entries.find((e): e is SessionHeader => e.type === 'header');
        if (!header) continue;
        const firstMsg = entries.find(
          (e): e is SessionMessage => e.type === 'message' && !e.content.startsWith('[Assistant]:'),
        );
        const preview = firstMsg ? firstMsg.content.slice(0, 50) : '(empty)';
        infos.push({ filePath, created: header.created, preview });
      } catch {
        // ignore unreadable files
      }
    }
    return infos;
  } catch {
    return [];
  }
}
