import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AgentContext {
  content: string;
  source: string;
}

const CANDIDATE_FILES = ['AGENTS.md', 'CLAUDE.md', '.local-agent/context.md'];

export function loadContext(projectRoot: string): AgentContext | null {
  for (const filename of CANDIDATE_FILES) {
    const filePath = join(projectRoot, filename);
    if (!existsSync(filePath)) continue;
    return {
      content: readFileSync(filePath, 'utf-8'),
      source: filename,
    };
  }
  return null;
}
