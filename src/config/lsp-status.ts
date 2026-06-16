import { detectLanguages, isCommandAvailable, LANGUAGE_ENTRIES } from '../tool/lsp-utils.js';

export interface LspStatus {
  lang: string;
  lspServer: string | null;
  lspStatus: 'active' | 'not_installed' | 'no_lsp';
  lspInstallCmd: string | null;
}

export function getLspStatuses(projectRoot: string): LspStatus[] {
  const langs = detectLanguages(projectRoot);
  return langs.map((lang) => {
    const entry = LANGUAGE_ENTRIES[lang];
    if (!entry?.lsp) {
      return { lang, lspServer: null, lspStatus: 'no_lsp', lspInstallCmd: null };
    }
    const installed = isCommandAvailable(entry.lsp.cmd);
    return {
      lang,
      lspServer: entry.lsp.cmd,
      lspStatus: installed ? 'active' : 'not_installed',
      lspInstallCmd: installed ? null : entry.lsp.installCmd,
    };
  });
}
