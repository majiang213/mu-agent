import { describe, it, expect } from 'vitest';
import { StateMachineAgent } from '../../../src/core/session/index.js';
import { State } from '../../../src/core/types.js';

describe('Bug 18: clone() resets fileCount to 0', () => {
  it('cloned agent does not inherit fileCount from parent', () => {
    // Arrange: parent agent has modified 3 files.
    const parent = new StateMachineAgent('model', [], 70e9);
    parent.recordToolCall('edit', { path: 'a.ts' }, {});
    parent.recordToolCall('edit', { path: 'b.ts' }, {});
    parent.recordToolCall('write', { path: 'c.ts' }, {});
    expect(parent.getFileCount()).toBe(3);

    // Act: clone the agent (as executeSteps does for parallel branches).
    const cloned = parent.clone();

    // Bug 18: clone() creates a new StateMachineAgent with fileCount=0.
    // In a parallel branch, the clone can modify maxFilesPerTask MORE files
    // beyond what the parent already used, defeating the safety limit.
    // After fix, clone should inherit the parent's fileCount.
    expect(cloned.getFileCount()).toBe(3);
  });

  it('parallel branch with clone can exceed maxFilesPerTask limit', () => {
    // Arrange: parent has used 2/2 file edits (SMALL model limit).
    const parent = new StateMachineAgent('model', [], 7e9); // SMALL: maxFilesPerTask=2
    parent.recordToolCall('edit', { path: 'a.ts' }, {});
    parent.recordToolCall('edit', { path: 'b.ts' }, {});
    expect(parent.canModifyMoreFiles()).toBe(false); // parent is at limit

    // Act: clone for a parallel branch.
    const cloned = parent.clone();

    // Bug 18: cloned agent starts with fileCount=0, so it thinks it can modify more files.
    // After fix, cloned.canModifyMoreFiles() should be false.
    expect(cloned.canModifyMoreFiles()).toBe(false);
  });
});

describe('Bug 19 (session/index.ts:133): resetForNextTask does not reset toolCalls/fileCount', () => {
  it('resetForNextTask resets fileCount and toolCalls', () => {
    // Arrange: agent has accumulated tool calls and file modifications.
    const agent = new StateMachineAgent('model', [], 70e9);
    agent.recordToolCall('edit', { path: 'a.ts' }, {});
    agent.recordToolCall('read', { path: 'b.ts' }, {});
    agent.recordToolCall('write', { path: 'c.ts' }, {});
    expect(agent.getFileCount()).toBe(2);

    // Act: reset for next task.
    agent.resetForNextTask(State.REASON);

    // Bug 19 (session/index.ts:133): resetForNextTask only resets currentState
    // and stateIteration, but NOT toolCalls or fileCount.
    // After fix, fileCount should be 0 and the agent should be able to modify files again.
    expect(agent.getFileCount()).toBe(0);
    expect(agent.canModifyMoreFiles()).toBe(true);
  });
});
