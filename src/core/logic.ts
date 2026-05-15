import { State, type StateConfig, type StateContext } from './types.js';

/**
 * Create initial state context
 */
export function createStateContext(state: State, task: string, _stateConfig: StateConfig): StateContext {
  return {
    state,
    task,
    history: [],
    availableTools: [], // Will be populated by StateMachine
  };
}
