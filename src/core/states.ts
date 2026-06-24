import { State, type ModelParams, type StateConfig } from './types.js';
import { STATE_REGISTRY } from './state-registry.js';

export function detectModelParams(paramCount: number | null): ModelParams {
  const billions = paramCount !== null ? paramCount / 1e9 : null;

  if (billions !== null && billions <= 9) {
    return {
      tier: 'SMALL',
      paramCount: billions,
      maxFilesPerTask: 2,
      maxRetries: 1,
      strictPlanning: true,
    };
  } else if (billions !== null && billions <= 30) {
    return {
      tier: 'MEDIUM',
      paramCount: billions,
      maxFilesPerTask: 4,
      maxRetries: 2,
      strictPlanning: true,
    };
  } else {
    return {
      tier: 'LARGE',
      paramCount: billions ?? 0,
      maxFilesPerTask: 8,
      maxRetries: 3,
      strictPlanning: false,
    };
  }
}

export function getBaseStateConfigs(): Record<State, StateConfig> {
  const entries = (Object.keys(STATE_REGISTRY) as State[]).map((state) => [
    state,
    { name: state, allowedTools: STATE_REGISTRY[state].allowedTools },
  ]);
  return Object.fromEntries(entries) as Record<State, StateConfig>;
}

export function getNextState(currentState: State, success: boolean = true): State {
  const transitions: Record<State, State> = {
    [State.LOCATE]: State.MODIFY,
    [State.MODIFY]: State.VERIFY,
    [State.VERIFY]: success ? State.DONE : State.ROLLBACK,
    [State.DONE]: State.DONE,
    [State.REASON]: State.LOCATE,
    [State.CLARIFY]: State.LOCATE,
    [State.ANSWER]: State.DONE,
    [State.DIAGNOSE]: State.LOCATE,
    [State.REVIEW]: State.DONE,
    [State.TEST_WRITE]: State.VERIFY,
    [State.REFACTOR_PLAN]: State.LOCATE,
    [State.ROLLBACK]: State.DONE,
    [State.RESEARCH]: State.DONE,
    [State.SETUP]: State.DONE,
    [State.WRITE]: State.DONE,
    [State.PLAN]: State.DONE,
  };

  return transitions[currentState];
}

export function advanceState(current: State, route: State[]): State {
  const idx = route.indexOf(current);
  return idx >= 0 && idx < route.length - 1 ? route[idx + 1]! : State.DONE;
}
