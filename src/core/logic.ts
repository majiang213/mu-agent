import { State, type StateConfig, type StateContext, type StateResult, type ToolCall, type ExitCheckResult } from './types.js';
import { getNextState } from './states.js';

/**
 * Check if state should exit based on LLM output
 */
export function checkExitCondition(
  state: State,
  iteration: number,
  maxIterations: number,
  llmOutput: string,
): ExitCheckResult {
  // Max iterations reached
  if (iteration >= maxIterations) {
    return {
      shouldExit: true,
      reason: 'Max iterations reached',
      nextState: getNextState(state, false),
    };
  }

  // Check for completion markers in output
  const completionMarkers = [
    '[COMPLETE]',
    '[DONE]',
    'Task completed',
    'Analysis complete',
  ];

  const hasCompletionMarker = completionMarkers.some((marker) =>
    llmOutput.includes(marker),
  );

  if (hasCompletionMarker) {
    return {
      shouldExit: true,
      reason: 'Completion marker detected',
      nextState: getNextState(state, true),
    };
  }

  // State-specific checks
  switch (state) {
    case State.ANALYZE:
      // Exit if we have identified files to modify
      if (llmOutput.includes('Files to modify:') || llmOutput.includes('Files that need')) {
        return {
          shouldExit: true,
          reason: 'Analysis complete - files identified',
          nextState: State.LOCATE,
        };
      }
      break;

    case State.LOCATE:
      // Exit if specific locations identified
      if (llmOutput.includes('Line') && (llmOutput.includes('function') || llmOutput.includes('class'))) {
        return {
          shouldExit: true,
          reason: 'Locations identified',
          nextState: State.MODIFY,
        };
      }
      break;

    case State.MODIFY:
      // Exit if changes are complete
      if (llmOutput.includes('Changes complete') || llmOutput.includes('Modified:')) {
        return {
          shouldExit: true,
          reason: 'Modifications complete',
          nextState: State.VERIFY,
        };
      }
      break;

    case State.VERIFY:
      // Exit based on verification result
      if (llmOutput.includes('Verification passed') || llmOutput.includes('All tests pass')) {
        return {
          shouldExit: true,
          reason: 'Verification passed',
          nextState: State.DONE,
        };
      }
      if (llmOutput.includes('Verification failed') || llmOutput.includes('Tests failed')) {
        return {
          shouldExit: true,
          reason: 'Verification failed - needs retry',
          nextState: State.MODIFY,
        };
      }
      break;
  }

  return {
    shouldExit: false,
    reason: 'Continue in current state',
    nextState: state,
  };
}

/**
 * Create initial state context
 */
export function createStateContext(
  state: State,
  task: string,
  stateConfig: StateConfig,
): StateContext {
  return {
    state,
    task,
    history: [],
    availableTools: [], // Will be populated by StateMachine
  };
}

/**
 * Format tool calls for LLM context
 */
export function formatToolCallsForContext(toolCalls: ToolCall[]): string {
  if (toolCalls.length === 0) return '';

  return toolCalls
    .map((call) => {
      const input = JSON.stringify(call.input);
      const output = JSON.stringify(call.output).slice(0, 500);
      return `Tool: ${call.tool}\nInput: ${input}\nOutput: ${output}...`;
    })
    .join('\n\n');
}
