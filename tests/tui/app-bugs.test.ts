import { describe, it, expect, vi, beforeEach } from 'vitest';

// Bug 11: tool_execution_end matches by tool name instead of toolId, causing parallel tool mismatch.
// Bug 12: clarification submit permanently locks editor (disableSubmit never reset).
// Bug 23: SamplingBlock not removed from TUI children after task ends.
// Bug 24: state_change→DONE doesn't clear currentTurn, ANSWER appends to wrong block.

// These bugs are in src/tui/app.ts which has complex TUI dependencies.
// We test by examining the source code structure and logic.

describe('Bug 11: tool_execution_end matches by tool name instead of toolId', () => {
  it('tool_execution_end uses toolId for matching, not tool name', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const sourcePath = path.join(process.cwd(), 'src/tui/app.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Find the tool_execution_end handler
    const endHandlerMatch = source.match(/tool_execution_end[\s\S]*?(?=} else if|$)/);
    expect(endHandlerMatch).not.toBeNull();

    const handler = endHandlerMatch![0];

    // Bug 11: The handler does:
    //   const entry = [...pendingTools.entries()].reverse().find(([, v]) => v === event.tool);
    // This matches by VALUE (tool name), not by key (toolId).
    // Two parallel 'read' calls would have different keys but same value,
    // and the wrong one gets resolved.

    // After fix, the handler should use a unique ID for matching.
    // The event should carry a toolId that matches the key in pendingTools.
    // Check that the find uses the key (toolId) for matching, not the value (tool name).
    expect(handler).not.toMatch(/\.find\(\(\[, v\]\) => v === event\.tool\)/);
  });
});

describe('Bug 12: clarification submit permanently locks editor', () => {
  it('handleSubmit resets disableSubmit after clarification early return', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const sourcePath = path.join(process.cwd(), 'src/tui/app.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Find the handleSubmit method
    const submitMatch = source.match(/private async handleSubmit[\s\S]*?(?=^\s*private|^\s*\}|$)/m);
    expect(submitMatch).not.toBeNull();

    const submitBody = submitMatch![0];

    // Bug 12: handleSubmit starts with this.editor.disableSubmit = true (line 914).
    // When a clarification is pending, it enters the early return path (line 928):
    //   if (this.pendingClarificationAgent) { ... agent.provideClarification(input); return; }
    // This return does NOT reset disableSubmit to false.
    // The editor is permanently locked.

    // After fix, the clarification return path should include:
    //   this.editor.disableSubmit = false;
    // before the return.

    // Find the clarification block
    const clarifyBlockMatch = submitBody.match(/if \(this\.pendingClarificationAgent\)[\s\S]*?return;/);
    if (clarifyBlockMatch) {
      const block = clarifyBlockMatch[0];
      // Bug 12: disableSubmit = false is missing before the return.
      expect(block).toContain('disableSubmit = false');
    }
  });
});

describe('Bug 23: SamplingBlock not removed after task ends', () => {
  it('samplingBlock is removed from TUI children when task ends', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const sourcePath = path.join(process.cwd(), 'src/tui/app.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Find where the loader is removed after task completion
    const loaderRemoveMatch = source.match(/this\.tui\.removeChild\(loader\)/g);
    expect(loaderRemoveMatch).not.toBeNull();

    // Bug 23: Only the loader is removed. The samplingBlock (created during
    // deliberation_start) is never removed from tui.children.
    // After fix, samplingBlock should also be removed at the same point.

    // Check if samplingBlock is also removed alongside loader
    const afterTaskMatch = source.match(/removeChild\(loader\)[\s\S]{0,200}removeChild\(samplingBlock\)/);
    // Bug 23: This pattern won't match because samplingBlock removal is missing.
    expect(afterTaskMatch).not.toBeNull();
  });
});

describe("Bug 24: state_change→DONE doesn't clear currentTurn", () => {
  it('state_change to DONE sets currentTurn/currentLlmTurn to null', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const sourcePath = path.join(process.cwd(), 'src/tui/app.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Find the state_change handler
    const stateChangeMatch = source.match(/if \(event\.type === 'state_change'\)[\s\S]*?(?=} else if)/);
    expect(stateChangeMatch).not.toBeNull();

    const handler = stateChangeMatch![0];

    // Bug 24: When event.to is 'DONE' or 'SAMPLING', the handler does NOT create
    // a new AssistantTurn and does NOT clear currentTurn/currentLlmTurn.
    // The condition is: if (event.to !== 'DONE' && event.to !== 'SAMPLING' && event.to !== prevState)
    // So DONE/SAMPLING are explicitly excluded from creating new turns.
    // But they also don't null out the current turn, leaving it stale.

    // After fix, there should be an else branch that sets currentTurn = null for DONE.
    // Check for null assignment in the DONE path.
    expect(handler).toMatch(/DONE[\s\S]*?currentTurn\s*=\s*null|currentLlmTurn\s*=\s*null/);
  });
});

// ---- Bug 25: conversationHistory append uses role:'user' for assistant ----

describe('Bug 25: assistant response appended with role:user', () => {
  it('assistant display message uses role "assistant" not "user"', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const sourcePath = path.join(process.cwd(), 'src/tui/app.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Find where assistant message is appended to conversationHistory
    const assistantMsgMatch = source.match(/role:\s*'user'[\s\S]*?\[Assistant\]/);
    // Bug 25: Line 1006 has:
    //   const assistantMsg = { role: 'user', content: `[Assistant]: ${display}`, ... }
    // Should be role: 'assistant'.
    // After fix, this pattern should not match (role should be 'assistant').
    expect(assistantMsgMatch).toBeNull();
  });
});

// ---- Bug 19 (app.ts:482): DebugBlock allocated even when debug is off ----

describe('Bug 19: DebugBlock allocated when debug mode is off', () => {
  it('does not allocate DebugBlock when debugMode is false', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const sourcePath = path.join(process.cwd(), 'src/tui/app.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Bug 19 (app.ts:482): DebugBlock is created in startLlmTurn regardless of debugMode.
    // Only setVisible(debugMode) is called. The object still exists in memory.
    // In long sessions, this causes memory leaks as DebugBlocks accumulate.

    // After fix, DebugBlock should only be created when debugMode is true.
    // Check if startLlmTurn has a conditional around DebugBlock creation.
    const startLlmTurnMatch = source.match(
      /startLlmTurn[\s\S]*?(?=^\s*(?:get thinking|update|finalize|addTool|resolveTool|invalidate|render|private|\}))/m,
    );
    if (startLlmTurnMatch) {
      const body = startLlmTurnMatch[0];
      // After fix, DebugBlock creation should be inside an if(debugMode) block.
      // Bug: DebugBlock is always created.
      expect(body).toMatch(/if\s*\(.*debugMode.*\)[\s\S]*?DebugBlock|DebugBlock[\s\S]*?if\s*\(.*debugMode/);
    }
  });
});

// ---- Bug 19 (app.ts:939): Loader color hardcoded to REASON ----

describe('Bug 19: Loader color hardcoded to REASON state', () => {
  it('Loader uses dynamic state color, not hardcoded REASON', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const sourcePath = path.join(process.cwd(), 'src/tui/app.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Bug 19 (app.ts:939): Loader is created with:
    //   new Loader(this.tui, (s) => stateColor('REASON')(s), ...)
    // All states show the same REASON color for the spinner.
    // After fix, it should use the current state's color.

    // Find Loader creation
    const loaderMatch = source.match(/new Loader\([^)]*\)/);
    expect(loaderMatch).not.toBeNull();

    // Bug: hardcoded 'REASON' in stateColor call.
    // After fix, should use a variable for the state.
    expect(loaderMatch![0]).not.toContain("stateColor('REASON')");
  });
});

// ---- Bug 19 (app.ts:1007): aborted/errored tasks don't persist user input ----

describe("Bug 19: aborted/errored tasks don't persist user input to sessionStore", () => {
  it('user input is persisted to sessionStore even when task is aborted', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const sourcePath = path.join(process.cwd(), 'src/tui/app.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Bug 19 (app.ts:1007): The sessionStore.append() for user input
    // is inside the try block after agent.run() succeeds.
    // If the task is aborted or throws, the user input is never persisted.
    // On session resume, the user's message is lost.

    // Find the catch block
    const catchMatch = source.match(/catch\s*\(err\)[\s\S]*?(?=finally)/);
    if (catchMatch) {
      const catchBody = catchMatch[0];
      // After fix, the catch block should also persist the user input.
      // Bug: no sessionStore.append in catch block.
      expect(catchBody).toContain('sessionStore.append');
    }
  });
});
