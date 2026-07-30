import type { ExecutionEvent } from '../core/agent/index.js';
import { fmtToolArgs } from './presenter.js';

/**
 * Console presenter — a stdout adapter over the ExecutionEvent union, used
 * by `mu-agent run` (no terminal). The SECOND adapter at the event seam
 * (the TUI's RunView is the first): two adapters make the seam real
 * (third-pass review, candidate 13).
 *
 * Selective by design: progress signals print, streaming chatter (thinking
 * deltas, sampling progress, token stats) stays off the console.
 */
export function createConsolePresenter(): (event: ExecutionEvent) => void {
  return (event: ExecutionEvent): void => {
    switch (event.type) {
      case 'state_change':
        if (event.to !== 'IDLE') console.log(`\n→ ${event.to}`);
        break;
      case 'tool_execution_start': {
        const arg = fmtToolArgs(event.tool, event.args);
        console.log(`  ⚙ ${event.tool}${arg ? `  ${arg}` : ''}`);
        break;
      }
      case 'tool_execution_end':
        if (event.isError) console.log(`  ✗ ${event.tool} failed`);
        break;
      case 'rollback_performed':
        console.log(`  ↩ rollback restored: ${event.files.join(', ')}`);
        break;
      case 'message_end':
        console.log(event.content);
        break;
      case 'clarification_needed':
        console.log(`\n? ${event.questions.join('\n? ')}`);
        break;
      case 'deliberation_fallback':
        console.log(`  ⚠ ${event.reason}`);
        break;
      case 'parallel_overlap':
        console.log(`  ⚠ parallel branches edited the same file(s): ${event.files.join(', ')}`);
        break;
      case 'plan_parse_error':
        console.log(`  ✗ subplan output unparseable (${event.analyzerState})`);
        break;
      default:
        break;
    }
  };
}
