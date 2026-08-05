import type { StepDirective } from '../types.js';

export interface PlanCandidate {
  steps: StepDirective[];
}

export interface DeliberationResult {
  synthesizedSteps: StepDirective[];
  deliberationSummary: string;
}

export type DeliberateOutcome =
  { type: 'selected'; result: DeliberationResult } | { type: 'needs_clarification'; question: string };
