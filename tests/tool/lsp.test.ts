import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LspClient, type LspConnection, type LspServerFactory } from '../../src/tool/lsp.js';

/**
 * These tests cross the LspConnection seam with a fake server — the previous
 * versions asserted on lsp.ts source text with fs.readFileSync + regex.
 */

interface FakeServer {
  connection: LspConnection;
  notifications: Array<{ method: string; params: unknown }>;
  publish(uri: string, diagnostics: unknown[]): void;
}

function makeFakeServer(): FakeServer {
  let diagnosticsHandler: ((params: { uri: string; diagnostics: never[] }) => void) | null = null;
  const server: FakeServer = {
    notifications: [],
    connection: {
      listen() {},
      onNotification(_method, handler) {
        diagnosticsHandler = handler as typeof diagnosticsHandler;
      },
      async sendRequest() {
        return {};
      },
      async sendNotification(method, params) {
        server.notifications.push({ method, params });
      },
      dispose() {},
    },
    publish(uri, diagnostics) {
      diagnosticsHandler?.({ uri, diagnostics: diagnostics as never[] });
    },
  };
  return server;
}

function makeClient(server: FakeServer): LspClient {
  const factory: LspServerFactory = () => ({ connection: server.connection, kill: () => {} });
  return new LspClient(factory);
}

function tmpTsFile(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lsp-seam-'));
  const file = join(dir, 'sample.ts');
  writeFileSync(file, 'const x: number = "oops";\n');
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('LspClient through the LspConnection seam', () => {
  it('sends didOpen before didChange for a new file', async () => {
    const server = makeFakeServer();
    const client = makeClient(server);
    const { dir, file, cleanup } = tmpTsFile();
    try {
      // Inject the connection directly (init() needs real language servers).
      await (
        client as unknown as { startServer: (l: string, c: string, a: string[], r: string) => Promise<void> }
      ).startServer('typescript', 'fake-server', [], dir);
      const wait = client.touchFile(file);
      // Give notifications a tick, then answer with diagnostics.
      await new Promise((r) => setTimeout(r, 10));
      server.publish(`file://${file}`, []);
      await wait;

      const methods = server.notifications.map((n) => n.method);
      expect(methods).toContain('textDocument/didOpen');
      expect(methods).toContain('textDocument/didChange');
      expect(methods.indexOf('textDocument/didOpen')).toBeLessThan(methods.indexOf('textDocument/didChange'));
    } finally {
      client.dispose();
      cleanup();
    }
  });

  it('sends didOpen only once per file across repeated touches', async () => {
    const server = makeFakeServer();
    const client = makeClient(server);
    const { dir, file, cleanup } = tmpTsFile();
    try {
      await (
        client as unknown as { startServer: (l: string, c: string, a: string[], r: string) => Promise<void> }
      ).startServer('typescript', 'fake-server', [], dir);
      for (let i = 0; i < 2; i++) {
        const wait = client.touchFile(file);
        await new Promise((r) => setTimeout(r, 10));
        server.publish(`file://${file}`, []);
        await wait;
      }
      const opens = server.notifications.filter((n) => n.method === 'textDocument/didOpen');
      expect(opens).toHaveLength(1);
    } finally {
      client.dispose();
      cleanup();
    }
  });

  it('returns only severity-1 diagnostics formatted as [LSP] lines', async () => {
    const server = makeFakeServer();
    const client = makeClient(server);
    const { dir, file, cleanup } = tmpTsFile();
    try {
      await (
        client as unknown as { startServer: (l: string, c: string, a: string[], r: string) => Promise<void> }
      ).startServer('typescript', 'fake-server', [], dir);
      const wait = client.touchFile(file);
      await new Promise((r) => setTimeout(r, 10));
      server.publish(`file://${file}`, [
        {
          range: { start: { line: 0, character: 6 } },
          severity: 1,
          message: "Type 'string' is not assignable to type 'number'.",
        },
        { range: { start: { line: 0, character: 0 } }, severity: 2, message: 'warning ignored' },
      ]);
      const lines = await wait;
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('[LSP]');
      expect(lines[0]).toContain(':1 -');
      expect(lines[0]).toContain("Type 'string' is not assignable");
    } finally {
      client.dispose();
      cleanup();
    }
  });

  it('returns [] for files with no language mapping or no server', async () => {
    const client = makeClient(makeFakeServer());
    expect(await client.touchFile('/tmp/whatever.unknownext')).toEqual([]);
    expect(await client.touchFile('/tmp/still-no-server.ts')).toEqual([]);
  });
});
