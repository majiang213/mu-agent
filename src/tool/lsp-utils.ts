import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function detectLanguage(cwd: string): string | null {
  if (existsSync(join(cwd, 'tsconfig.json'))) return 'typescript';
  if (existsSync(join(cwd, 'package.json'))) return 'javascript';
  if (existsSync(join(cwd, 'pyproject.toml'))) return 'python';
  if (existsSync(join(cwd, 'requirements.txt'))) return 'python';
  if (existsSync(join(cwd, 'Cargo.toml'))) return 'rust';
  if (existsSync(join(cwd, 'go.mod'))) return 'go';
  return null;
}

export function isCommandAvailable(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
