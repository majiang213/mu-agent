import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

describe('detectLanguages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects typescript from tsconfig.json', async () => {
    const { existsSync } = await import('node:fs');
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('tsconfig.json'));
    const { detectLanguages } = await import('../../src/tool/lsp-utils.js');
    expect(detectLanguages('/project')).toContain('typescript');
  });

  it('detects python from pyproject.toml', async () => {
    const { existsSync } = await import('node:fs');
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('pyproject.toml'));
    const { detectLanguages } = await import('../../src/tool/lsp-utils.js');
    expect(detectLanguages('/project')).toContain('python');
  });

  it('detects rust from Cargo.toml', async () => {
    const { existsSync } = await import('node:fs');
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('Cargo.toml'));
    const { detectLanguages } = await import('../../src/tool/lsp-utils.js');
    expect(detectLanguages('/project')).toContain('rust');
  });

  it('detects java from pom.xml', async () => {
    const { existsSync } = await import('node:fs');
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('pom.xml'));
    const { detectLanguages } = await import('../../src/tool/lsp-utils.js');
    expect(detectLanguages('/project')).toContain('java');
  });

  it('detects multiple languages when multiple marker files exist', async () => {
    const { existsSync } = await import('node:fs');
    vi.mocked(existsSync).mockImplementation(
      (p) => String(p).endsWith('tsconfig.json') || String(p).endsWith('pom.xml'),
    );
    const { detectLanguages } = await import('../../src/tool/lsp-utils.js');
    const langs = detectLanguages('/project');
    expect(langs).toContain('typescript');
    expect(langs).toContain('java');
  });

  it('returns empty array when no known file exists', async () => {
    const { existsSync } = await import('node:fs');
    const { readdirSync } = await import('node:fs');
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readdirSync).mockReturnValue([]);
    const { detectLanguages } = await import('../../src/tool/lsp-utils.js');
    expect(detectLanguages('/project')).toEqual([]);
  });

  it('detects csharp via glob when .csproj file exists', async () => {
    const { existsSync } = await import('node:fs');
    const { readdirSync } = await import('node:fs');
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readdirSync).mockReturnValue(['MyApp.csproj'] as unknown as ReturnType<
      typeof import('node:fs').readdirSync
    >);
    const { detectLanguages } = await import('../../src/tool/lsp-utils.js');
    expect(detectLanguages('/project')).toContain('csharp');
  });
});

describe('fileExtToLanguage', () => {
  it('maps .ts to typescript', async () => {
    const { fileExtToLanguage } = await import('../../src/tool/lsp-utils.js');
    expect(fileExtToLanguage('.ts')).toBe('typescript');
  });

  it('maps .java to java', async () => {
    const { fileExtToLanguage } = await import('../../src/tool/lsp-utils.js');
    expect(fileExtToLanguage('.java')).toBe('java');
  });

  it('maps .py to python', async () => {
    const { fileExtToLanguage } = await import('../../src/tool/lsp-utils.js');
    expect(fileExtToLanguage('.py')).toBe('python');
  });

  it('returns null for unknown extension', async () => {
    const { fileExtToLanguage } = await import('../../src/tool/lsp-utils.js');
    expect(fileExtToLanguage('.unknown')).toBeNull();
  });
});

describe('getLspStatuses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when no languages detected', async () => {
    const { existsSync } = await import('node:fs');
    const { readdirSync } = await import('node:fs');
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readdirSync).mockReturnValue([]);
    const { getLspStatuses } = await import('../../src/config/lsp-status.js');
    expect(getLspStatuses('/project')).toEqual([]);
  });

  it('returns active status when typescript server is installed', async () => {
    const { existsSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('tsconfig.json'));
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));
    const { getLspStatuses } = await import('../../src/config/lsp-status.js');
    const statuses = getLspStatuses('/project');
    const ts = statuses.find((s) => s.lang === 'typescript');
    expect(ts).toBeDefined();
    expect(ts!.lspStatus).toBe('active');
    expect(ts!.lspServer).toBe('typescript-language-server');
    expect(ts!.lspInstallCmd).toBeNull();
  });

  it('returns not_installed with install cmd when server missing', async () => {
    const { existsSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('tsconfig.json'));
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('not found');
    });
    const { getLspStatuses } = await import('../../src/config/lsp-status.js');
    const statuses = getLspStatuses('/project');
    const ts = statuses.find((s) => s.lang === 'typescript');
    expect(ts!.lspStatus).toBe('not_installed');
    expect(ts!.lspInstallCmd).toBe('npm install -g typescript-language-server typescript');
  });

  it('returns correct server for go', async () => {
    const { existsSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('go.mod'));
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('not found');
    });
    const { getLspStatuses } = await import('../../src/config/lsp-status.js');
    const statuses = getLspStatuses('/project');
    const go = statuses.find((s) => s.lang === 'go');
    expect(go!.lspServer).toBe('gopls');
    expect(go!.lspInstallCmd).toBe('go install golang.org/x/tools/gopls@latest');
  });
});
