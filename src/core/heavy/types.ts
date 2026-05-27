import type { Step, State } from '../types.js';

export interface PlanCandidate {
  id: string;
  steps: Step[];
  sampledAt: number;
}

export interface DeliberationResult {
  selectedPlan: PlanCandidate;
  deliberationSummary: string;
  rejectedPlans: Array<{
    plan: PlanCandidate;
    reason: string;
  }>;
}

export type DeliberateOutcome =
  | { type: 'selected'; result: DeliberationResult }
  | { type: 'needs_clarification'; question: string }
  | { type: 'needs_plan_selection'; candidates: PlanCandidate[]; summaries: string[] };

export interface StepTrajectory {
  state: State;
  focus: string;
  toolCallSummary: string[];
  chosenPath: string;
}
