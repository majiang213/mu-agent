import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import { State, type ModelParams, type StateConfig } from './types.js';
import { STATE_REGISTRY } from './state-registry.js';

const STATE_SCHEMAS: Partial<Record<State, ReturnType<typeof Type.Object>>> = {
  [State.LOCATE]: Type.Object({ locations: Type.Array(Type.Unknown()) }),
  [State.MODIFY]: Type.Object({ edited: Type.String() }),
  [State.VERIFY]: Type.Object({ passed: Type.Boolean() }),
  [State.CLARIFY]: Type.Object({ questions: Type.Array(Type.Unknown()) }),
  [State.DIAGNOSE]: Type.Object({ rootCause: Type.String() }),
  [State.REVIEW]: Type.Object({ verdict: Type.String() }),
  [State.TEST_WRITE]: Type.Object({ testFile: Type.String() }),
  [State.ROLLBACK]: Type.Object({ restored: Type.Array(Type.String()) }),
  [State.REFACTOR_PLAN]: Type.Object({ refactorSteps: Type.Array(Type.Unknown()) }),
  [State.SETUP]: Type.Object({ created: Type.String() }),
};

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
  };

  return transitions[currentState];
}

// ─── State completion detection ───────────────────────────────────────────────

function extractJson(text: string): Record<string, unknown> | null {
  // Strip markdown code fences first
  const stripped = text.replace(/```[a-z]*\n?/g, '').replace(/```/g, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function hasStateCompletionJson(state: State, text: string): boolean {
  const json = extractJson(text);
  if (!json) return false;
  if (state === State.REASON) {
    const steps = json['steps'];
    const needsClarify = json['needsClarify'] === true;
    return Array.isArray(steps) && (needsClarify || (steps as unknown[]).length > 0);
  }
  const schema = STATE_SCHEMAS[state];
  if (!schema) return false;
  return Value.Check(schema, json);
}

export function advanceState(current: State, route: State[]): State {
  const idx = route.indexOf(current);
  return idx >= 0 && idx < route.length - 1 ? route[idx + 1]! : State.DONE;
}
