import { detectLanguage, isCommandAvailable } from '../tool/lsp-utils.js';

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
  return detectLanguage(projectRoot);
}

export function isLspCommandAvailable(cmd: string): boolean {
  return isCommandAvailable(cmd);
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
