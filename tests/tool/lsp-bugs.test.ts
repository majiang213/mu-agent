import { describe, it, expect, vi, beforeEach } from 'vitest';

// Bug 7: touchFile sends didChange without didOpen, LSP server silently discards.

describe('Bug 7: LspClient.touchFile missing didOpen notification', () => {
  it('touchFile sends textDocument/didOpen before textDocument/didChange', () => {
    // Bug 7: touchFile() at line 103 directly sends textDocument/didChange
    // without first sending textDocument/didOpen.
    // LSP protocol requires didOpen before didChange.
    // The server silently discards didChange for unopened documents.
    //
    // We verify by checking the source code.
    const fs = require('node:fs');
    const path = require('node:path');
    const sourcePath = path.join(process.cwd(), 'src/tool/lsp.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Find the touchFile method
    const touchFileMatch = source.match(/async touchFile[\s\S]*?(?=^\s*(?:dispose|}|$))/m);
    expect(touchFileMatch).not.toBeNull();

    const touchFileBody = touchFileMatch![0];

    // Bug 7: touchFile only sends didChange, not didOpen.
    // After fix, it should send didOpen first (or track opened URIs).
    expect(touchFileBody).toContain('didOpen');

    // Also verify didChange is still sent (the main action)
    expect(touchFileBody).toContain('didChange');
  });

  it('touchFile tracks already-opened URIs to avoid duplicate didOpen', () => {
    // Bug 7: After the fix, touchFile should track which URIs have been opened
    // and only send didOpen once per URI.
    const fs = require('node:fs');
    const path = require('node:path');
    const sourcePath = path.join(process.cwd(), 'src/tool/lsp.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // After fix, there should be a Set or Map tracking opened URIs.
    // Look for opened tracking in the LspClient class.
    const classBody = source.match(/export class LspClient[\s\S]*?(?=^export|$)/m);
    expect(classBody).not.toBeNull();

    // The class should have a field to track opened URIs.
    // Bug 7: No such tracking exists.
    expect(classBody![0]).toMatch(/opened|openedUris|openedFiles/);
  });

  it('touchFile uses event-based diagnostic waiting instead of fixed 500ms sleep', () => {
    // Bug 7: Line 108 uses a fixed 500ms sleep before reading diagnostics.
    // On large files or slow machines, publishDiagnostics may not arrive in time.
    // After fix, it should use a Promise that resolves when publishDiagnostics fires.
    const fs = require('node:fs');
    const path = require('node:path');
    const sourcePath = path.join(process.cwd(), 'src/tool/lsp.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    const touchFileMatch = source.match(/async touchFile[\s\S]*?(?=^\s*(?:dispose|}|$))/m);
    const touchFileBody = touchFileMatch![0];

    // Bug 7: Uses setTimeout(r, 500) — a fixed delay.
    // After fix, should use a Promise-based approach (e.g., waiting for diagnostics notification).
    expect(touchFileBody).not.toContain('setTimeout');
  });
});
