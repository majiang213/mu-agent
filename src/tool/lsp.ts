import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import type { MessageConnection } from 'vscode-jsonrpc';
import { detectLanguages, fileExtToLanguage, isCommandAvailable, LANGUAGE_ENTRIES } from './lsp-utils.js';

function resolveAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

interface Diagnostic {
  range: { start: { line: number; character: number } };
  severity?: 1 | 2 | 3 | 4;
  message: string;
  source?: string;
}

interface ConnectionState {
  process: ChildProcess;
  connection: MessageConnection;
  diagnosticsMap: Map<string, Diagnostic[]>;
  diagnosticsWaiters: Map<string, (diagnostics: Diagnostic[]) => void>;
  openedUris: Set<string>;
}

export class LspClient {
  private connections = new Map<string, ConnectionState>();

  async init(projectRoot: string): Promise<void> {
    const root = resolve(projectRoot);
    const langs = detectLanguages(root);
    const startedCmds = new Set<string>();
    await Promise.all(
      langs.map(async (lang) => {
        const entry = LANGUAGE_ENTRIES[lang];
        if (!entry?.lsp) return;
        if (startedCmds.has(entry.lsp.cmd)) return;
        if (!isCommandAvailable(entry.lsp.cmd)) return;
        startedCmds.add(entry.lsp.cmd);
        await this.startServer(lang, entry.lsp.cmd, entry.lsp.args, projectRoot);
      }),
    );
  }

  private async startServer(lang: string, cmd: string, args: string[], projectRoot: string): Promise<void> {
    try {
      const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: projectRoot });
      if (!proc.stdout || !proc.stdin) {
        proc.kill();
        return;
      }
      proc.stderr?.on('data', () => {});

      const diagnosticsMap = new Map<string, Diagnostic[]>();
      const diagnosticsWaiters = new Map<string, (d: Diagnostic[]) => void>();
      const openedUris = new Set<string>();

      const connection = createMessageConnection(
        new StreamMessageReader(proc.stdout),
        new StreamMessageWriter(proc.stdin),
      );
      connection.listen();

      connection.onNotification(
        'textDocument/publishDiagnostics',
        (params: { uri: string; diagnostics: Diagnostic[] }) => {
          diagnosticsMap.set(params.uri, params.diagnostics);
          const waiter = diagnosticsWaiters.get(params.uri);
          if (waiter) {
            diagnosticsWaiters.delete(params.uri);
            waiter(params.diagnostics);
          }
        },
      );

      await connection.sendRequest('initialize', {
        rootUri: `file://${resolve(projectRoot)}`,
        processId: process.pid,
        capabilities: {
          textDocument: { synchronization: { didOpen: true, didChange: true }, publishDiagnostics: {} },
        },
        workspaceFolders: [{ name: 'workspace', uri: `file://${resolve(projectRoot)}` }],
      });

      await connection.sendNotification('initialized', {});
      this.connections.set(lang, { process: proc, connection, diagnosticsMap, diagnosticsWaiters, openedUris });
    } catch (err) {
      console.warn(`[lsp] Failed to start ${cmd}:`, err instanceof Error ? err.message : String(err));
    }
  }

  async touchFile(filePath: string): Promise<string[]> {
    const ext = extname(filePath);
    const lang = fileExtToLanguage(ext);
    if (!lang) return [];

    const state = this.connections.get(lang);
    if (!state) return [];

    const absPath = resolve(filePath);
    const uri = `file://${absPath}`;
    try {
      const content = readFileSync(absPath, 'utf-8');

      if (!state.openedUris.has(uri)) {
        await state.connection.sendNotification('textDocument/didOpen', {
          textDocument: { uri, languageId: lang, version: 1, text: content },
        });
        state.openedUris.add(uri);
      }

      state.diagnosticsMap.delete(uri);

      await state.connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: Date.now() },
        contentChanges: [{ text: content }],
      });

      const existingWaiter = state.diagnosticsWaiters.get(uri);
      if (existingWaiter) {
        state.diagnosticsWaiters.delete(uri);
        existingWaiter([]);
      }

      const diagnostics = await new Promise<Diagnostic[]>((resolve) => {
        const cleanup = (diags: Diagnostic[]) => {
          state.diagnosticsWaiters.delete(uri);
          resolve(diags);
        };
        void resolveAfter(5000, state.diagnosticsMap.get(uri) ?? []).then((fallback) => {
          if (state.diagnosticsWaiters.has(uri)) cleanup(fallback);
        });
        state.diagnosticsWaiters.set(uri, cleanup);
      });

      return diagnostics
        .filter((d) => d.severity === 1)
        .map((d) => `[LSP] ${filePath}:${d.range.start.line + 1} - ${d.message}`);
    } catch {
      return [];
    }
  }

  dispose(): void {
    for (const [, state] of this.connections) {
      for (const waiter of state.diagnosticsWaiters.values()) waiter([]);
      state.diagnosticsWaiters.clear();
      try {
        state.connection.dispose();
      } catch {
        void 0;
      }
      state.process.kill();
    }
    this.connections.clear();
  }
}
