import { type Component, truncateToWidth } from '@mariozechner/pi-tui';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

export interface HeaderState {
  model: string;
  state: string;
  taskIndex: number;
  taskTotal: number;
  contextPct: number;
}

function getGitBranch(): string {
  try {
    return execSync('git branch --show-current', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function shortenCwd(cwd: string): string {
  const home = homedir();
  return cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
}

export class HeaderComponent implements Component {
  private cwd: string;
  private branch: string;
  private state: HeaderState;

  constructor(initialState: HeaderState) {
    this.cwd = shortenCwd(process.cwd());
    this.branch = getGitBranch();
    this.state = { ...initialState };
  }

  update(patch: Partial<HeaderState>): void {
    Object.assign(this.state, patch);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { model, state, taskIndex, taskTotal, contextPct } = this.state;

    const parts: string[] = [];
    parts.push(this.cwd);
    if (this.branch) parts.push(this.branch);
    parts.push(model);

    const taskLabel = taskTotal > 0 ? `${state} [${taskIndex}/${taskTotal}]` : state;
    parts.push(taskLabel);

    const ctxLabel = `ctx ${contextPct}%`;
    parts.push(ctxLabel);

    const line = ' ' + parts.join('  │  ') + ' ';
    return [truncateToWidth(line, width)];
  }
}
