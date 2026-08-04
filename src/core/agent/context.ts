import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { loadProjectContextFiles } from '@earendil-works/pi-coding-agent';

export interface AgentContext {
  content: string;
  source: string;
}

const MU_CONTEXT_FILE = join('.mu-agent', 'context.md');

/**
 * Load agent context via pi's loadProjectContextFiles (Gap 86): global
 * agentDir file + ancestor walk from filesystem root down to projectRoot
 * (per-directory first match of AGENTS.md/CLAUDE.md). mu-agent's own
 * `.mu-agent/context.md` stays as an appended project-level section.
 *
 * Content is the full concatenation (no truncation); source lists the
 * contributing files (project-relative where possible).
 */
export function loadContext(projectRoot: string, agentDir = join(homedir(), '.mu-agent')): AgentContext | null {
  const parts = loadProjectContextFiles({ cwd: projectRoot, agentDir });

  const muPath = join(projectRoot, MU_CONTEXT_FILE);
  if (existsSync(muPath)) {
    parts.push({ path: muPath, content: readFileSync(muPath, 'utf-8') });
  }

  if (parts.length === 0) return null;

  const displayPath = (p: string): string => {
    const rel = relative(projectRoot, p);
    return rel.length > 0 && !rel.startsWith('..') ? rel : p;
  };

  return {
    content: parts.map((p) => p.content).join('\n\n'),
    source: parts.map((p) => displayPath(p.path)).join(', '),
  };
}
