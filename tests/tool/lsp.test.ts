import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LspClient, type LspConnection, type LspServerFactory } from '../../src/tool/lsp.js';

/**
 * These tests cross the LspConnection seam with a fake server — the previous
 * versions asserted on lsp.ts source text with fs.readFileSync + regex.
 * init() is driven headlessly through the commandAvailable probe
 * (round-7, candidate 10) — no private startServer pokes.
 */

interface FakeServer {
  connection: LspConnection;
  requests: Array<{ method: string }>;
  notifications: Array<{ method: string; params: unknown }>;
  publish(uri: string, diagnostics: unknown[]): void;
}

function makeFakeServer(): FakeServer {
  let diagnosticsHandler: ((params: { uri: string; diagnostics: never[] }) => void) | null = null;
  const server: FakeServer = {
    requests: [],
    notifications: [],
    connection: {
      listen() {},
      onNotification(_method, handler) {
        diagnosticsHandler = handler as typeof diagnosticsHandler;
      },
      async sendRequest(method) {
        server.requests.push({ method });
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

interface ClientHarness {
  client: LspClient;
  server: FakeServer;
  factoryCalls: Array<{ cmd: string }>;
  dir: string;
  file: string;
  cleanup: () => void;
}

function makeHarness(
  opts: { commandAvailable?: (cmd: string) => boolean; diagnosticsTimeoutMs?: number } = {},
): ClientHarness {
  const dir = mkdtempSync(join(tmpdir(), 'lsp-seam-'));
  // tsconfig.json → typescript detected by init()'s detectLanguages.
  writeFileSync(join(dir, 'tsconfig.json'), '{}\n');
  const file = join(dir, 'sample.ts');
  writeFileSync(file, 'const x: number = "oops";\n');

  const server = makeFakeServer();
  const factoryCalls: Array<{ cmd: string }> = [];
  const factory: LspServerFactory = (cmd) => {
    factoryCalls.push({ cmd });
    return { connection: server.connection, kill: () => {} };
  };
  const client = new LspClient({
    serverFactory: factory,
    commandAvailable: opts.commandAvailable ?? (() => true),
    ...(opts.diagnosticsTimeoutMs !== undefined ? { diagnosticsTimeoutMs: opts.diagnosticsTimeoutMs } : {}),
  });
  return { client, server, factoryCalls, dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('LspClient through the LspConnection seam', () => {
  it('init() starts the detected language server through the probe', async () => {
    const h = makeHarness();
    try {
      await h.client.init(h.dir);
      expect(h.factoryCalls.map((c) => c.cmd)).toEqual(['typescript-language-server']);
      expect(h.server.requests.map((r) => r.method)).toContain('initialize');
      expect(h.server.notifications.map((n) => n.method)).toContain('initialized');
    } finally {
      h.client.dispose();
      h.cleanup();
    }
  });

  it('init() skips servers the probe reports as not installed', async () => {
    const h = makeHarness({ commandAvailable: () => false });
    try {
      await h.client.init(h.dir);
      expect(h.factoryCalls).toHaveLength(0);
    } finally {
      h.client.dispose();
      h.cleanup();
    }
  });

  it('init() dedups languages sharing one server cmd', async () => {
    const h = makeHarness();
    try {
      // package.json → javascript also detected; both entries use
      // typescript-language-server, so the factory must fire exactly once.
      writeFileSync(join(h.dir, 'package.json'), '{}\n');
      await h.client.init(h.dir);
      expect(h.factoryCalls).toHaveLength(1);
    } finally {
      h.client.dispose();
      h.cleanup();
    }
  });

  it('sends didOpen before didChange for a new file', async () => {
    const h = makeHarness();
    try {
      await h.client.init(h.dir);
      const wait = h.client.touchFile(h.file);
      // Give notifications a tick, then answer with diagnostics.
      await new Promise((r) => setTimeout(r, 10));
      h.server.publish(`file://${h.file}`, []);
      await wait;

      const methods = h.server.notifications.map((n) => n.method);
      expect(methods).toContain('textDocument/didOpen');
      expect(methods).toContain('textDocument/didChange');
      expect(methods.indexOf('textDocument/didOpen')).toBeLessThan(methods.indexOf('textDocument/didChange'));
    } finally {
      h.client.dispose();
      h.cleanup();
    }
  });

  it('sends didOpen only once per file across repeated touches', async () => {
    const h = makeHarness();
    try {
      await h.client.init(h.dir);
      for (let i = 0; i < 2; i++) {
        const wait = h.client.touchFile(h.file);
        await new Promise((r) => setTimeout(r, 10));
        h.server.publish(`file://${h.file}`, []);
        await wait;
      }
      const opens = h.server.notifications.filter((n) => n.method === 'textDocument/didOpen');
      expect(opens).toHaveLength(1);
    } finally {
      h.client.dispose();
      h.cleanup();
    }
  });

  it('returns only severity-1 diagnostics formatted as [LSP] lines', async () => {
    const h = makeHarness();
    try {
      await h.client.init(h.dir);
      const wait = h.client.touchFile(h.file);
      await new Promise((r) => setTimeout(r, 10));
      h.server.publish(`file://${h.file}`, [
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
      h.client.dispose();
      h.cleanup();
    }
  });

  it('times out to [] when the server never publishes diagnostics', async () => {
    const h = makeHarness({ diagnosticsTimeoutMs: 20 });
    try {
      await h.client.init(h.dir);
      const started = Date.now();
      const lines = await h.client.touchFile(h.file);
      expect(lines).toEqual([]);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      h.client.dispose();
      h.cleanup();
    }
  });

  it('returns [] for files with no language mapping or no server', async () => {
    const h = makeHarness();
    try {
      expect(await h.client.touchFile('/tmp/whatever.unknownext')).toEqual([]);
      expect(await h.client.touchFile('/tmp/still-no-server.ts')).toEqual([]);
    } finally {
      h.client.dispose();
      h.cleanup();
    }
  });
});
