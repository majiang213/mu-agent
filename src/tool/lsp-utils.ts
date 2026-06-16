import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface LanguageEntry {
  detectFiles: string[];
  extensions: string[];
  lsp?: {
    cmd: string;
    args: string[];
    installCmd: string;
  };
}

export const LANGUAGE_ENTRIES: Record<string, LanguageEntry> = {
  typescript: {
    detectFiles: ['tsconfig.json'],
    extensions: ['.ts', '.tsx', '.mts'],
    lsp: {
      cmd: 'typescript-language-server',
      args: ['--stdio'],
      installCmd: 'npm install -g typescript-language-server typescript',
    },
  },
  javascript: {
    detectFiles: ['package.json'],
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    lsp: {
      cmd: 'typescript-language-server',
      args: ['--stdio'],
      installCmd: 'npm install -g typescript-language-server typescript',
    },
  },
  python: {
    detectFiles: ['pyproject.toml', 'requirements.txt'],
    extensions: ['.py'],
    lsp: {
      cmd: 'pyright-langserver',
      args: ['--stdio'],
      installCmd: 'pip install pyright',
    },
  },
  rust: {
    detectFiles: ['Cargo.toml'],
    extensions: ['.rs'],
    lsp: {
      cmd: 'rust-analyzer',
      args: [],
      installCmd: 'rustup component add rust-analyzer',
    },
  },
  go: {
    detectFiles: ['go.mod'],
    extensions: ['.go'],
    lsp: {
      cmd: 'gopls',
      args: [],
      installCmd: 'go install golang.org/x/tools/gopls@latest',
    },
  },
  java: {
    detectFiles: ['pom.xml', 'build.gradle'],
    extensions: ['.java'],
    lsp: {
      cmd: 'jdtls',
      args: [],
      installCmd: 'See https://github.com/eclipse-jdtls/eclipse.jdt.ls#installation',
    },
  },
  c_cpp: {
    detectFiles: ['CMakeLists.txt', 'Makefile'],
    extensions: ['.c', '.cpp', '.h', '.hpp', '.cc', '.cxx'],
    lsp: {
      cmd: 'clangd',
      args: [],
      installCmd: 'brew install llvm  # or: apt install clangd',
    },
  },
  csharp: {
    detectFiles: ['*.csproj', '*.sln'],
    extensions: ['.cs'],
    lsp: {
      cmd: 'omnisharp',
      args: ['-lsp'],
      installCmd: 'dotnet tool install -g OmniSharp',
    },
  },
  ruby: {
    detectFiles: ['Gemfile'],
    extensions: ['.rb'],
    lsp: {
      cmd: 'solargraph',
      args: ['stdio'],
      installCmd: 'gem install solargraph',
    },
  },
  kotlin: {
    detectFiles: ['build.gradle.kts'],
    extensions: ['.kt', '.kts'],
    lsp: {
      cmd: 'kotlin-language-server',
      args: [],
      installCmd: 'See https://github.com/fwcd/kotlin-language-server#installation',
    },
  },
};

const EXT_TO_LANG: Map<string, string> = new Map();
for (const [lang, entry] of Object.entries(LANGUAGE_ENTRIES)) {
  for (const ext of entry.extensions) {
    if (!EXT_TO_LANG.has(ext)) {
      EXT_TO_LANG.set(ext, lang);
    }
  }
}

function matchesDetectFile(cwd: string, pattern: string): boolean {
  if (pattern.startsWith('*')) {
    const suffix = pattern.slice(1);
    try {
      const files = readdirSync(cwd);
      return files.some((f) => f.endsWith(suffix));
    } catch {
      return false;
    }
  }
  return existsSync(join(cwd, pattern));
}

export function detectLanguages(cwd: string): string[] {
  const detected: string[] = [];
  for (const [lang, entry] of Object.entries(LANGUAGE_ENTRIES)) {
    const found = entry.detectFiles.some((f) => matchesDetectFile(cwd, f));
    if (found) detected.push(lang);
  }
  return detected;
}

export function fileExtToLanguage(ext: string): string | null {
  return EXT_TO_LANG.get(ext) ?? null;
}

export function isCommandAvailable(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
