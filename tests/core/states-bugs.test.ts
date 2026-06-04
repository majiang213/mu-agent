import { describe, it, expect } from 'vitest';
import { getNextState, getBaseStateConfigs, hasStateCompletionJson } from '../../src/core/states.js';
import { State } from '../../src/core/types.js';

// ---- Bug 19 (states.ts:114): getNextState ignores success parameter ----

describe('Bug 19: getNextState ignores success parameter', () => {
  it('VERIFY with success=false should not transition to DONE', () => {
    // Arrange: VERIFY failed.
    // Bug 19 (states.ts:114): getNextState ignores the success parameter.
    // When VERIFY fails (success=false), the next state should NOT be DONE.
    // It should be something like ROLLBACK or REASON for retry.
    const nextState = getNextState(State.VERIFY, false);

    // Bug: getNextState always returns State.DONE for VERIFY regardless of success.
    // After fix, VERIFY with success=false should return a different state (e.g., ROLLBACK).
    expect(nextState).not.toBe(State.DONE);
  });

  it('VERIFY with success=true should transition to DONE', () => {
    const nextState = getNextState(State.VERIFY, true);
    expect(nextState).toBe(State.DONE);
  });
});

// ---- Bug 26: ROLLBACK allowedTools missing bash and edit ----

describe('Bug 26: ROLLBACK allowedTools missing bash and edit', () => {
  it('ROLLBACK state includes bash in allowedTools', () => {
    const configs = getBaseStateConfigs();
    const rollbackTools = configs[State.ROLLBACK].allowedTools;

    // Bug 26: ROLLBACK only has ['read', 'write', 'complete'].
    // It needs 'bash' to run 'git checkout' and 'edit' for partial modifications.
    expect(rollbackTools).toContain('bash');
  });

  it('ROLLBACK state includes edit in allowedTools', () => {
    const configs = getBaseStateConfigs();
    const rollbackTools = configs[State.ROLLBACK].allowedTools;

    // Bug 26: 'edit' is missing, forcing the model to use 'write' for full-file rewrites.
    expect(rollbackTools).toContain('edit');
  });
});

// ---- Bug 19 (states.ts:104): TEST_WRITE allowedTools missing edit ----

describe('Bug 19: TEST_WRITE allowedTools missing edit', () => {
  it('TEST_WRITE state includes edit in allowedTools', () => {
    const configs = getBaseStateConfigs();
    const testWriteTools = configs[State.TEST_WRITE].allowedTools;

    // Bug 19 (states.ts:104): TEST_WRITE has ['read', 'write', 'complete'].
    // It needs 'edit' to modify existing test files.
    expect(testWriteTools).toContain('edit');
  });
});

// ---- Bug 19 (states.ts:179): ROLLBACK has no hasStateCompletionJson case ----

describe('Bug 19: ROLLBACK has no hasStateCompletionJson case', () => {
  it('hasStateCompletionJson returns true for valid ROLLBACK output', () => {
    const validRollbackJson = '{"restored": ["src/a.ts", "src/b.ts"]}';

    // Bug 19 (states.ts:179): STATE_SCHEMAS does not have a ROLLBACK entry,
    // so hasStateCompletionJson always returns false for ROLLBACK.
    // After fix, a schema like Type.Object({ restored: Type.Array(Type.String()) }) should be added.
    const result = hasStateCompletionJson(State.ROLLBACK, validRollbackJson);
    expect(result).toBe(true);
  });

  it('hasStateCompletionJson returns false for invalid ROLLBACK output', () => {
    const invalidJson = '{"wrong": "format"}';
    const result = hasStateCompletionJson(State.ROLLBACK, invalidJson);
    expect(result).toBe(false);
  });
});
