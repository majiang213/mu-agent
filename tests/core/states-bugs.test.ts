import { describe, it, expect } from 'vitest';
import { State } from '../../src/core/types.js';
import { STATE_REGISTRY } from '../../src/core/state-registry.js';

// Regression pins for per-state allowedTools, now read straight from the
// registry (getBaseStateConfigs was a pure pass-through and was deleted).

describe('Bug 26: ROLLBACK allowedTools missing bash and edit', () => {
  it('ROLLBACK state includes bash in allowedTools', () => {
    // ROLLBACK needs 'bash' to run 'git checkout' style restores.
    expect(STATE_REGISTRY[State.ROLLBACK].allowedTools).toContain('bash');
  });

  it('ROLLBACK state includes edit in allowedTools', () => {
    // ROLLBACK needs 'edit' for partial modifications.
    expect(STATE_REGISTRY[State.ROLLBACK].allowedTools).toContain('edit');
  });
});

describe('Bug 19: TEST_WRITE allowedTools missing edit', () => {
  it('TEST_WRITE state includes edit in allowedTools', () => {
    // TEST_WRITE needs 'edit' to modify existing test files.
    expect(STATE_REGISTRY[State.TEST_WRITE].allowedTools).toContain('edit');
  });
});
