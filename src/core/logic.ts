import { State, type StateConfig, type StateContext, type StateResult, type ToolCall, type ExitCheckResult } from './types.js';
import { getNextState } from './states.js';

/**
 * Check if state should exit based on LLM output
 */
function tryParseJson(output: string): Record<string, unknown> | null {
  const trimmed = output.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function checkExitCondition(
  state: State,
  iteration: number,
  maxIterations: number,
  llmOutput: string,
): ExitCheckResult {
  // Max iterations reached — always exit, move to next state
  if (iteration >= maxIterations) {
    return {
      shouldExit: true,
      reason: 'Max iterations reached',
      nextState: getNextState(state, false),
    };
  }

  // Any valid JSON response means the model completed this state's task
  const parsed = tryParseJson(llmOutput);
  if (parsed !== null) {
    const success = !parsed['error'];
    return {
      shouldExit: true,
      reason: success ? 'State completed' : 'State completed with error',
      nextState: getNextState(state, success),
    };
  }

  // Non-JSON but non-empty response — treat as completed after first iteration
  if (llmOutput.trim().length > 0 && iteration >= 1) {
    return {
      shouldExit: true,
      reason: 'Non-JSON response accepted',
      nextState: getNextState(state, true),
    };
  }

  // State-specific fallback checks (legacy, kept as safety net)
  switch (state) {
    case State.VERIFY:
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
