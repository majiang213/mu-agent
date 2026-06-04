import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/lib/node/main.js';
import type { MessageConnection } from 'vscode-jsonrpc/lib/common/api.js';
import { detectLanguage, isCommandAvailable } from './lsp-utils.js';

interface Diagnostic {
  range: { start: { line: number; character: number } };
  severity?: 1 | 2 | 3 | 4;
  message: string;
  source?: string;
}

const LANGUAGE_SERVERS: Record<string, { cmd: string; args: string[] }> = {
  typescript: { cmd: 'typescript-language-server', args: ['--stdio'] },
  javascript: { cmd: 'typescript-language-server', args: ['--stdio'] },
  python: { cmd: 'pyright-langserver', args: ['--stdio'] },
  rust: { cmd: 'rust-analyzer', args: [] },
  go: { cmd: 'gopls', args: [] },
};

export class LspClient {
  private connection: MessageConnection | null = null;
  private diagnosticsMap = new Map<string, Diagnostic[]>();
  private openedUris = new Set<string>();
  private initialized = false;

  async init(projectRoot: string): Promise<void> {
    const lang = detectLanguage(resolve(projectRoot));
    if (!lang) return;

    const server = LANGUAGE_SERVERS[lang];
    if (!server) return;

    if (!isCommandAvailable(server.cmd)) return;

    try {
      const proc = spawn(server.cmd, server.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: projectRoot,
      });

      if (!proc.stdout || !proc.stdin) return;

      this.connection = createMessageConnection(
        new StreamMessageReader(proc.stdout),
        new StreamMessageWriter(proc.stdin),
      );
      this.connection.listen();

      this.connection.onNotification(
        'textDocument/publishDiagnostics',
        (params: { uri: string; diagnostics: Diagnostic[] }) => {
          this.diagnosticsMap.set(params.uri, params.diagnostics);
        },
      );

      await this.connection.sendRequest('initialize', {
        rootUri: `file://${resolve(projectRoot)}`,
        processId: process.pid,
        capabilities: {
          textDocument: {
            synchronization: { didOpen: true, didChange: true },
            publishDiagnostics: {},
          },
        },
        workspaceFolders: [{ name: 'workspace', uri: `file://${resolve(projectRoot)}` }],
      });

      await this.connection.sendNotification('initialized', {});
      this.initialized = true;
    } catch {
      this.connection = null;
    }
  }

  async touchFile(filePath: string): Promise<string[]> {
    if (!this.initialized || !this.connection) return [];
    const openedUris = this.openedUris; // track opened URIs for didOpen notification
    const absPath = resolve(filePath);
    const uri = `file://${absPath}`;
    try {
      const content = readFileSync(absPath, 'utf-8');
      if (!openedUris.has(uri)) {
        await this.connection.sendNotification('textDocument/didOpen', {
          textDocument: { uri, languageId: detectLanguage(absPath) ?? 'plaintext', version: 1, text: content },
        });
        openedUris.add(uri);
      }
      await this.connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: Date.now() },
        contentChanges: [{ text: content }],
      });

      // Wait for publishDiagnostics notification (event-based instead of fixed delay)
      const waitDeadline = Date.now() + 500;
      while (!this.diagnosticsMap.has(uri) && Date.now() < waitDeadline) {
        await new Promise<void>((r) => queueMicrotask(() => r()));
      }

      const diagnostics = this.diagnosticsMap.get(uri) ?? [];
      return diagnostics
        .filter((d) => d.severity === 1)
        .map((d) => `[LSP] ${filePath}:${d.range.start.line + 1} - ${d.message}`);
    } catch {
      return [];
    }
  }

  dispose(): void {
    try {
      this.connection?.dispose();
    } catch {
      void 0;
    }
    this.connection = null;
    this.initialized = false;
    this.diagnosticsMap.clear();
  }
}

// LspClient exported via class declaration above
