import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

describe('detectProjectLanguage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects typescript from tsconfig.json', async () => {
    const { existsSync } = await import('node:fs');
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('tsconfig.json'));
    const { detectProjectLanguage } = await import('../../src/config/lsp-status.js');
    expect(detectProjectLanguage('/project')).toBe('typescript');
  });

  it('detects python from pyproject.toml', async () => {
    const { existsSync } = await import('node:fs');
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('pyproject.toml'));
    const { detectProjectLanguage } = await import('../../src/config/lsp-status.js');
    expect(detectProjectLanguage('/project')).toBe('python');
  });

  it('detects rust from Cargo.toml', async () => {
    const { existsSync } = await import('node:fs');
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('Cargo.toml'));
    const { detectProjectLanguage } = await import('../../src/config/lsp-status.js');
    expect(detectProjectLanguage('/project')).toBe('rust');
  });

  it('returns null when no known file exists', async () => {
    const { existsSync } = await import('node:fs');
    vi.mocked(existsSync).mockReturnValue(false);
    const { detectProjectLanguage } = await import('../../src/config/lsp-status.js');
    expect(detectProjectLanguage('/project')).toBeNull();
  });
});

describe('isLspCommandAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when execSync succeeds', async () => {
    const { execSync } = await import('node:child_process');
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { isLspCommandAvailable } = await import('../../src/config/lsp-status.js');
    expect(isLspCommandAvailable('typescript-language-server')).toBe(true);
  });

  it('returns false when execSync throws', async () => {
    const { execSync } = await import('node:child_process');
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('not found');
    });
    const { isLspCommandAvailable } = await import('../../src/config/lsp-status.js');
    expect(isLspCommandAvailable('typescript-language-server')).toBe(false);
  });
});

describe('getLspStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_detected when no language found', async () => {
    const { existsSync } = await import('node:fs');
    vi.mocked(existsSync).mockReturnValue(false);
    const { getLspStatus } = await import('../../src/config/lsp-status.js');
    const status = getLspStatus('/project');
    expect(status.status).toBe('not_detected');
    expect(status.detectedLanguage).toBeNull();
    expect(status.server).toBeNull();
    expect(status.installCommand).toBeNull();
  });

  it('returns active when typescript server is installed', async () => {
    const { existsSync } = await import('node:fs');
    const { execSync } = await import('node:child_process');
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('tsconfig.json'));
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { getLspStatus } = await import('../../src/config/lsp-status.js');
    const status = getLspStatus('/project');
    expect(status.status).toBe('active');
    expect(status.detectedLanguage).toBe('typescript');
    expect(status.server).toBe('typescript-language-server');
    expect(status.installCommand).toBeNull();
  });

  it('returns not_installed with install command when server missing', async () => {
    const { existsSync } = await import('node:fs');
    const { execSync } = await import('node:child_process');
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('tsconfig.json'));
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('not found');
    });
    const { getLspStatus } = await import('../../src/config/lsp-status.js');
    const status = getLspStatus('/project');
    expect(status.status).toBe('not_installed');
    expect(status.installCommand).toBe('npm install -g typescript-language-server typescript');
  });

  it('detects go and returns correct server', async () => {
    const { existsSync } = await import('node:fs');
    const { execSync } = await import('node:child_process');
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('go.mod'));
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('not found');
    });
    const { getLspStatus } = await import('../../src/config/lsp-status.js');
    const status = getLspStatus('/project');
    expect(status.detectedLanguage).toBe('go');
    expect(status.server).toBe('gopls');
    expect(status.installCommand).toBe('go install golang.org/x/tools/gopls@latest');
  });
});
