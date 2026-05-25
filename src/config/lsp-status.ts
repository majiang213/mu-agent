import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface LspStatus {
  detectedLanguage: string | null;
  server: string | null;
  status: 'active' | 'not_installed' | 'not_detected';
  installCommand: string | null;
}

const LANGUAGE_SERVERS: Record<string, { cmd: string }> = {
  typescript: { cmd: 'typescript-language-server' },
  javascript: { cmd: 'typescript-language-server' },
  python: { cmd: 'pyright-langserver' },
  rust: { cmd: 'rust-analyzer' },
  go: { cmd: 'gopls' },
};

const INSTALL_COMMANDS: Record<string, string> = {
  typescript: 'npm install -g typescript-language-server typescript',
  javascript: 'npm install -g typescript-language-server typescript',
  python: 'pip install pyright',
  rust: 'rustup component add rust-analyzer',
  go: 'go install golang.org/x/tools/gopls@latest',
};

export function detectProjectLanguage(projectRoot: string): string | null {
  if (existsSync(join(projectRoot, 'tsconfig.json'))) return 'typescript';
  if (existsSync(join(projectRoot, 'package.json'))) return 'javascript';
  if (existsSync(join(projectRoot, 'pyproject.toml'))) return 'python';
  if (existsSync(join(projectRoot, 'requirements.txt'))) return 'python';
  if (existsSync(join(projectRoot, 'Cargo.toml'))) return 'rust';
  if (existsSync(join(projectRoot, 'go.mod'))) return 'go';
  return null;
}

export function isLspCommandAvailable(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getLspStatus(projectRoot: string): LspStatus {
  const lang = detectProjectLanguage(projectRoot);
  if (!lang) {
    return { detectedLanguage: null, server: null, status: 'not_detected', installCommand: null };
  }

  const serverInfo = LANGUAGE_SERVERS[lang];
  if (!serverInfo) {
    return { detectedLanguage: lang, server: null, status: 'not_detected', installCommand: null };
  }

  const installed = isLspCommandAvailable(serverInfo.cmd);
  return {
    detectedLanguage: lang,
    server: serverInfo.cmd,
    status: installed ? 'active' : 'not_installed',
    installCommand: installed ? null : (INSTALL_COMMANDS[lang] ?? null),
  };
}
