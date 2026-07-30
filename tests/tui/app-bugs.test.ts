import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Source-pinning tests for the TuiApp wiring that cannot be exercised
// headlessly (Editor/terminal construction). The behavioral bugs that used
// to live here (11, 23, 24, 25, 19-DebugBlock) moved to run-view.test.ts —
// the RunViewHost seam made them testable for real.
//
// Remaining:
// Bug 12: clarification submit permanently locks editor (disableSubmit never reset).
// Bug 19: Loader color hardcoded to REASON state.
// Bug 19: aborted/errored tasks don't persist user input to sessionStore.

const source = readFileSync(join(process.cwd(), 'src/tui/app.ts'), 'utf-8');

describe('Bug 12: clarification submit permanently locks editor', () => {
  it('handleSubmit resets disableSubmit after clarification early return', () => {
    // Method body runs to the class-closing brace at column 0.
    const submitMatch = source.match(/private async handleSubmit[\s\S]*?(?=\n\})/);
    expect(submitMatch).not.toBeNull();

    const submitBody = submitMatch![0];
    const clarifyBlockMatch = submitBody.match(/if \(this\.pendingClarificationAgent\)[\s\S]*?return;/);
    expect(clarifyBlockMatch).not.toBeNull();
    expect(clarifyBlockMatch![0]).toContain('disableSubmit = false');
  });
});

describe('Bug 19: Loader color hardcoded to REASON', () => {
  it('Loader uses the dynamic run-view state color', () => {
    expect(source).not.toContain("stateColor('REASON')");
    expect(source).toContain('stateColor(this.runView?.loaderState');
  });
});

describe("Bug 19: aborted/errored tasks don't persist user input", () => {
  it('the catch path persists the user turn too', () => {
    const catchMatch = source.match(/catch\s*\(err\)[\s\S]*?(?=finally)/);
    expect(catchMatch).not.toBeNull();
    // persistTurn(input) is the one contained persistence path (success AND catch).
    expect(catchMatch![0]).toContain('persistTurn(input');
  });
});
