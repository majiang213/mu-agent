import { State } from './types.js';
import type { TaskType } from './types.js';

const ROUTE_TABLE: Record<TaskType, State[]> = {
  CODING: [State.ANALYZE, State.LOCATE, State.MODIFY, State.VERIFY, State.DONE],
  BUGFIX: [State.DIAGNOSE, State.LOCATE, State.MODIFY, State.VERIFY, State.DONE],
  REFACTORING: [State.ANALYZE, State.REFACTOR_PLAN, State.LOCATE, State.MODIFY, State.VERIFY, State.DONE],
  TESTING: [State.ANALYZE, State.LOCATE, State.TEST_WRITE, State.VERIFY, State.DONE],
  DOCUMENTATION: [State.ANALYZE, State.LOCATE, State.MODIFY, State.DONE],
  REVIEW: [State.REVIEW, State.DONE],
  ANALYSIS: [State.ANSWER, State.DONE],
  QUESTION: [State.ANSWER, State.DONE],
  UNKNOWN: [State.ANALYZE, State.LOCATE, State.MODIFY, State.VERIFY, State.DONE],
};

export function resolveRoute(type: TaskType, needsClarify: boolean): State[] {
  const route = ROUTE_TABLE[type];
  return needsClarify ? [State.CLARIFY, ...route] : route;
}
