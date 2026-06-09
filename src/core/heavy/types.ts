import type { Step } from '../types.js';

export interface PlanCandidate {
  id: string;
  steps: Step[];
  sampledAt: number;
}

export interface DeliberationResult {
  synthesizedSteps: Step[];
  deliberationSummary: string;
}

export type DeliberateOutcome =
  | { type: 'selected'; result: DeliberationResult }
  | { type: 'needs_clarification'; question: string };
