import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@mariozechner/pi-tui', () => ({
  TUI: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    addChild: vi.fn(),
    removeChild: vi.fn(),
    setFocus: vi.fn(),
    requestRender: vi.fn(),
    addInputListener: vi.fn().mockReturnValue(vi.fn()),
    children: [],
  })),
  ProcessTerminal: vi.fn(),
  Text: vi.fn().mockImplementation((text: string) => ({ text, invalidate: vi.fn(), render: vi.fn() })),
  Input: vi.fn(),
  Loader: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    setMessage: vi.fn(),
    invalidate: vi.fn(),
    render: vi.fn(),
  })),
  SelectList: vi.fn(),
}));

vi.mock('../../src/config/index.js', () => ({
  saveConfig: vi.fn(),
}));

vi.mock('../../src/config/lsp-status.js', () => ({
  getLspStatus: vi.fn(),
}));

vi.mock('../../src/provider/model-info.js', () => ({
  fetchOllamaModels: vi.fn(),
  fetchCustomModels: vi.fn(),
}));

describe('SetupWizard.loadExistingModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty object when no config file exists', async () => {
    const dir = join(tmpdir(), `setup-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const origCwd = process.cwd;
      process.cwd = () => dir;
      const { SetupWizard } = await import('../../src/tui/setup.js');
      const wizard = new SetupWizard();
      const result = (wizard as unknown as { loadExistingModel: () => object }).loadExistingModel();
      expect(result).toEqual({});
      process.cwd = origCwd;
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('returns model config when project config exists', async () => {
    const dir = join(tmpdir(), `setup-test-${Date.now()}`);
    mkdirSync(join(dir, '.local-agent'), { recursive: true });
    writeFileSync(
      join(dir, '.local-agent', 'config.json'),
      JSON.stringify({ model: { provider: 'ollama', name: 'llama3:8b', baseUrl: 'http://localhost:11434' } }),
    );
    try {
      const origCwd = process.cwd;
      process.cwd = () => dir;
      const { SetupWizard } = await import('../../src/tui/setup.js');
      const wizard = new SetupWizard();
      const result = (wizard as unknown as { loadExistingModel: () => object }).loadExistingModel();
      expect(result).toMatchObject({ provider: 'ollama', name: 'llama3:8b' });
      process.cwd = origCwd;
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('returns empty object when config file is malformed JSON', async () => {
    const dir = join(tmpdir(), `setup-test-${Date.now()}`);
    mkdirSync(join(dir, '.local-agent'), { recursive: true });
    writeFileSync(join(dir, '.local-agent', 'config.json'), 'not json {{{{');
    try {
      const origCwd = process.cwd;
      process.cwd = () => dir;
      const { SetupWizard } = await import('../../src/tui/setup.js');
      const wizard = new SetupWizard();
      const result = (wizard as unknown as { loadExistingModel: () => object }).loadExistingModel();
      expect(result).toEqual({});
      process.cwd = origCwd;
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('SetupWizard graphBuilt state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('graphBuilt is null initially', async () => {
    const { SetupWizard } = await import('../../src/tui/setup.js');
    const wizard = new SetupWizard();
    expect((wizard as unknown as { graphBuilt: boolean | null }).graphBuilt).toBeNull();
  });
});

describe('stepDone graphOk logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows graph failure when graphBuilt is false (even if graph.db exists)', async () => {
    const dir = join(tmpdir(), `setup-test-${Date.now()}`);
    mkdirSync(join(dir, '.local-agent'), { recursive: true });
    writeFileSync(join(dir, '.local-agent', 'graph.db'), '');

    const { getLspStatus } = await import('../../src/config/lsp-status.js');
    vi.mocked(getLspStatus).mockReturnValue({
      status: 'active',
      detectedLanguage: 'typescript',
      server: 'typescript-language-server',
      installCommand: null,
    });

    const origCwd = process.cwd;
    process.cwd = () => dir;
    try {
      const { SetupWizard } = await import('../../src/tui/setup.js');
      const wizard = new SetupWizard();
      (wizard as unknown as { graphBuilt: boolean | null }).graphBuilt = false;

      const textContents: string[] = [];
      const { Text } = await import('@mariozechner/pi-tui');
      vi.mocked(Text).mockImplementation((text: string) => {
        textContents.push(text);
        return { text, invalidate: vi.fn(), render: vi.fn() } as unknown as InstanceType<typeof Text>;
      });

      (wizard as unknown as { stepDone: () => void }).stepDone();

      const combined = textContents.join('');
      expect(combined).toContain('代码图未构建');
    } finally {
      process.cwd = origCwd;
      rmSync(dir, { recursive: true });
    }
  });

  it('shows graph success when graphBuilt is true', async () => {
    const dir = join(tmpdir(), `setup-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    const { getLspStatus } = await import('../../src/config/lsp-status.js');
    vi.mocked(getLspStatus).mockReturnValue({
      status: 'not_detected',
      detectedLanguage: null,
      server: null,
      installCommand: null,
    });

    const origCwd = process.cwd;
    process.cwd = () => dir;
    try {
      const { SetupWizard } = await import('../../src/tui/setup.js');
      const wizard = new SetupWizard();
      (wizard as unknown as { graphBuilt: boolean | null }).graphBuilt = true;

      const textContents: string[] = [];
      const { Text } = await import('@mariozechner/pi-tui');
      vi.mocked(Text).mockImplementation((text: string) => {
        textContents.push(text);
        return { text, invalidate: vi.fn(), render: vi.fn() } as unknown as InstanceType<typeof Text>;
      });

      (wizard as unknown as { stepDone: () => void }).stepDone();

      const combined = textContents.join('');
      expect(combined).toContain('代码图已构建');
    } finally {
      process.cwd = origCwd;
      rmSync(dir, { recursive: true });
    }
  });

  it('falls back to file check when graphBuilt is null (user skipped)', async () => {
    const dir = join(tmpdir(), `setup-test-${Date.now()}`);
    mkdirSync(join(dir, '.local-agent'), { recursive: true });
    writeFileSync(join(dir, '.local-agent', 'graph.db'), '');

    const { getLspStatus } = await import('../../src/config/lsp-status.js');
    vi.mocked(getLspStatus).mockReturnValue({
      status: 'not_detected',
      detectedLanguage: null,
      server: null,
      installCommand: null,
    });

    const origCwd = process.cwd;
    process.cwd = () => dir;
    try {
      const { SetupWizard } = await import('../../src/tui/setup.js');
      const wizard = new SetupWizard();

      const textContents: string[] = [];
      const { Text } = await import('@mariozechner/pi-tui');
      vi.mocked(Text).mockImplementation((text: string) => {
        textContents.push(text);
        return { text, invalidate: vi.fn(), render: vi.fn() } as unknown as InstanceType<typeof Text>;
      });

      (wizard as unknown as { stepDone: () => void }).stepDone();

      const combined = textContents.join('');
      expect(combined).toContain('代码图已构建');
    } finally {
      process.cwd = origCwd;
      rmSync(dir, { recursive: true });
    }
  });
});
