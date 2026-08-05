import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readExistingDefaults } from '../../src/config/loader.js';
import { parseModelSizeInput, providerNeedsModelSize, providerSelectItems } from '../../src/tui/setup-logic.js';
import { PROVIDER_FACTS } from '../../src/provider/providers.js';

/**
 * Round-7 (candidate 5): wizard DECISIONS are tested terminal-free — the
 * pi-tui module mock below survives only for the stepDone/graphBuilt
 * presentation tests at the bottom, which exercise the widget layer itself.
 */

vi.mock('@earendil-works/pi-tui', () => ({
  TUI: vi.fn().mockImplementation(function () {
    return {
      start: vi.fn(),
      stop: vi.fn(),
      addChild: vi.fn(),
      removeChild: vi.fn(),
      setFocus: vi.fn(),
      requestRender: vi.fn(),
      addInputListener: vi.fn().mockReturnValue(vi.fn()),
      children: [],
    };
  }),
  ProcessTerminal: vi.fn(),
  Text: vi.fn().mockImplementation(function (text: string) {
    return { text, invalidate: vi.fn(), render: vi.fn() };
  }),
  Input: vi.fn(),
  Loader: vi.fn().mockImplementation(function () {
    return {
      start: vi.fn(),
      stop: vi.fn(),
      setMessage: vi.fn(),
      invalidate: vi.fn(),
      render: vi.fn(),
    };
  }),
  SelectList: vi.fn(),
}));

vi.mock('../../src/tool/lsp-status.js', () => ({
  getLspStatuses: vi.fn(),
}));

function withCwd<T>(dir: string, fn: () => T): T {
  const origCwd = process.cwd;
  process.cwd = () => dir;
  try {
    return fn();
  } finally {
    process.cwd = origCwd;
  }
}

function makeDir(withConfig?: string): string {
  const dir = join(tmpdir(), `setup-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  if (withConfig !== undefined) {
    mkdirSync(join(dir, '.mu-agent'), { recursive: true });
    writeFileSync(join(dir, '.mu-agent', 'config.json'), withConfig);
  } else {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

describe('readExistingDefaults (loader one reader — replaces the wizard homegrown pair)', () => {
  it('returns empty when no config file exists', () => {
    const dir = makeDir();
    try {
      expect(withCwd(dir, () => readExistingDefaults())).toEqual({});
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('returns model + theme when the project config carries them', () => {
    const dir = makeDir(
      JSON.stringify({
        model: { provider: 'ollama', name: 'llama3:8b', baseUrl: 'http://localhost:11434' },
        theme: 'dark',
      }),
    );
    try {
      const out = withCwd(dir, () => readExistingDefaults());
      expect(out.model).toMatchObject({ provider: 'ollama', name: 'llama3:8b' });
      expect(out.theme).toBe('dark');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('skips a malformed file and keeps scanning', () => {
    const dir = makeDir('not json {{{{');
    try {
      expect(withCwd(dir, () => readExistingDefaults())).toEqual({});
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('parseModelSizeInput', () => {
  it('blank means skip (treated as large)', () => {
    expect(parseModelSizeInput('')).toBeUndefined();
    expect(parseModelSizeInput('   ')).toBeUndefined();
  });

  it('keeps finite positive numbers', () => {
    expect(parseModelSizeInput('7')).toBe(7);
    expect(parseModelSizeInput(' 7.5 ')).toBe(7.5);
  });

  it('drops junk and non-positive values', () => {
    expect(parseModelSizeInput('abc')).toBeUndefined();
    expect(parseModelSizeInput('0')).toBeUndefined();
    expect(parseModelSizeInput('-3')).toBeUndefined();
  });
});

describe('provider facts derivation (round-7, C6)', () => {
  it('select items mirror the one table', () => {
    const items = providerSelectItems();
    expect(items.map((i) => i.value)).toEqual(PROVIDER_FACTS.map((f) => f.name));
    expect(items.find((i) => i.value === 'unsloth')?.description).toContain('8888');
  });

  it('needsModelSize matches the probing reality (ollama probes, others ask)', () => {
    expect(providerNeedsModelSize('ollama')).toBe(false);
    expect(providerNeedsModelSize('unsloth')).toBe(true);
    expect(providerNeedsModelSize('custom')).toBe(true);
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

  async function renderStepDone(dir: string, graphBuilt: boolean | null): Promise<string> {
    const { SetupWizard } = await import('../../src/tui/setup.js');
    const wizard = new SetupWizard();
    (wizard as unknown as { graphBuilt: boolean | null }).graphBuilt = graphBuilt;

    const textContents: string[] = [];
    const { Text } = await import('@earendil-works/pi-tui');
    vi.mocked(Text).mockImplementation(function (text?: string) {
      textContents.push(text ?? '');
      return { text, invalidate: vi.fn(), render: vi.fn() } as unknown as InstanceType<typeof Text>;
    });

    withCwd(dir, () => (wizard as unknown as { stepDone: () => void }).stepDone());
    return textContents.join('');
  }

  it('shows graph failure when graphBuilt is false (even if graph.db exists)', async () => {
    const dir = makeDir('');
    writeFileSync(join(dir, '.mu-agent', 'graph.db'), '');
    const { getLspStatuses } = await import('../../src/tool/lsp-status.js');
    vi.mocked(getLspStatuses).mockReturnValue([
      { lang: 'typescript', lspServer: 'typescript-language-server', lspStatus: 'active', lspInstallCmd: null },
    ]);
    try {
      expect(await renderStepDone(dir, false)).toContain('Code graph not built');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('shows graph success when graphBuilt is true', async () => {
    const dir = makeDir();
    const { getLspStatuses } = await import('../../src/tool/lsp-status.js');
    vi.mocked(getLspStatuses).mockReturnValue([]);
    try {
      expect(await renderStepDone(dir, true)).toContain('Code graph built');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('falls back to file check when graphBuilt is null (user skipped)', async () => {
    const dir = makeDir('');
    writeFileSync(join(dir, '.mu-agent', 'graph.db'), '');
    const { getLspStatuses } = await import('../../src/tool/lsp-status.js');
    vi.mocked(getLspStatuses).mockReturnValue([]);
    try {
      expect(await renderStepDone(dir, null)).toContain('Code graph built');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
