import { homedir } from 'node:os';

/** '~/x/y' presentation of an absolute path — the header and the prompt env
 * block state this collapse once here (round-8, candidate 7). */
export function collapseHome(absPath: string): string {
  const home = homedir();
  return absPath.startsWith(home) ? '~' + absPath.slice(home.length) : absPath;
}
