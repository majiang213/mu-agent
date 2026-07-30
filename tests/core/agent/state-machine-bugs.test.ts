import { describe, it, expect } from 'vitest';
import { StateMachineAgent } from '../../../src/core/agent/state-machine.js';
import { State } from '../../../src/core/types.js';

describe('Bug 19 (agent/state-machine.ts): resetForNextTask resets fileCount', () => {
  it('resetForNextTask resets fileCount', () => {
    // Arrange: agent has accumulated tool calls and file modifications.
    const agent = new StateMachineAgent('model', [], 70e9);
    agent.recordToolCall('edit');
    agent.recordToolCall('read');
    agent.recordToolCall('write');
    expect(agent.getFileCount()).toBe(2);

    // Act: reset for next task.
    agent.resetForNextTask(State.REASON);

    // Bug 19 (agent/state-machine.ts:133): resetForNextTask only resets currentState
    // and stateIteration, but NOT toolCalls or fileCount.
    // After fix, fileCount should be 0 and the agent should be able to modify files again.
    expect(agent.getFileCount()).toBe(0);
    expect(agent.canModifyMoreFiles(5)).toBe(true);
  });
});
