import { State } from './types.js';
import type { IntentType } from './types.js';

const EXECUTION_PLANS: Record<IntentType, State[]> = {
  CODING: [State.ANALYZE, State.LOCATE, State.MODIFY, State.VERIFY, State.DONE],
  BUGFIX: [State.DIAGNOSE, State.LOCATE, State.MODIFY, State.VERIFY, State.DONE],
  REFACTORING: [State.ANALYZE, State.REFACTOR_PLAN, State.LOCATE, State.MODIFY, State.VERIFY, State.DONE],
  TESTING: [State.ANALYZE, State.LOCATE, State.TEST_WRITE, State.VERIFY, State.DONE],
  DOCUMENTATION: [State.ANALYZE, State.LOCATE, State.MODIFY, State.DONE],
  REVIEW: [State.REVIEW, State.DONE],
  ANALYSIS: [State.ANSWER, State.DONE],
  QUESTION: [State.ANSWER, State.DONE],
  RUN: [State.RUN, State.DONE],
  RESEARCH: [State.RESEARCH, State.DONE],
  SETUP: [State.SETUP, State.DONE],
  UNKNOWN: [State.ANALYZE, State.LOCATE, State.MODIFY, State.VERIFY, State.DONE],
};

export function plan(type: IntentType, needsClarify: boolean): State[] {
  const trajectory = EXECUTION_PLANS[type];
  return needsClarify ? [State.CLARIFY, ...trajectory] : trajectory;
}
