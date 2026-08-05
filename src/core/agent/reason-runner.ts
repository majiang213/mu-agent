import type { Agent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import { StagnationDetector } from '../cognitive/index.js';
import { retryDelayMs, sleep } from '../failure/index.js';
import { escalatedTemperature } from '../../config/defaults.js';
import { CompleteCapture } from '../../tool/complete.js';
import { buildSystemPrompt } from '../prompts/agent.js';
import { buildStepAgent, steer, subscribeStepEvents } from './builder.js';
import { parseDirectives } from './directives.js';
import { isAbortError } from './abort.js';
import { State } from '../types.js';
import type { StepDirective } from '../types.js';
import type {
  DriveUntilCompleteOptions,
  ExecutionEvent,
  Mission,
  RunConfig,
  RunPhase,
  StepAgentDriver,
} from './types.js';

/**
 * Reason runner — the LLM-call engine of the agent loop: runStepAgent
 * (prompt + retry) and runReasonAttempt (one REASON planning attempt).
 *
 * Lives in its own module to keep the dependency graph acyclic: the Heavy
 * Thinking sampler and the step executor BOTH depend on this seam instead
 * of importing each other (second-pass review, candidate 4a).
 */
export async function runStepAgent(
  agent: Agent,
  input: string,
  cfg: RunConfig,
  stagnationDetector: StagnationDetector,
): Promise<void> {
  // The one statement of the retry budget (the old tier-differentiated
  // ModelParams.maxRetries was clamped to exactly this — round-8, candidate 1).
  const maxRetries = 3;
  const baseTemperature = cfg.temperature;
  let attempt = 0;
  let lastError: Error | undefined;
  try {
    while (attempt < maxRetries) {
      try {
        await agent.prompt(input);
        return;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;
        if (isAbortError(error)) {
          return;
        }
        await sleep(retryDelayMs(attempt));
        // Escalate temperature for the next attempt. This writes to the
        // PER-STEP spread callers hand in (runStep / runReasonAttempt spread
        // RunConfig before building the agent — C14), so the shared config
        // is never mutated; buildStepAgent's streamFn closure reads
        // temperature lazily at call time, so the escalation reaches the
        // model without an agent rebuild. Restored in finally as hygiene.
        cfg.temperature = escalatedTemperature(attempt);
        stagnationDetector.reset();
        cfg.stateMachine.resetFileBudget();
        // Restore + clear only THIS step's checkpoints (owner = this step's
        // stateMachine instance) — the store is shared, a store-wide wipe
        // would disarm rollback for parallel siblings and prior steps.
        await cfg.safeModifier.restoreAndClearWhere(cfg.stateMachine);
      }
      attempt++;
    }
    throw lastError ?? new Error('runStepAgent: max retries exhausted');
  } finally {
    cfg.temperature = baseTemperature;
  }
}

/** The one reminder prompt used when re-driving after a nudge. */
const REMINDER_PROMPT = '[REMINDER] Call complete() now.';

/**
 * Nudge the agent with per-site guidance, then drive it again with the one
 * REMINDER prompt. The public re-drive for custom branches (clarification
 * answers, invalid-plan errors) that driveUntilComplete does not own.
 */
async function redrive(
  agent: Agent,
  steerContent: string,
  cfg: RunConfig,
  stagnationDetector: StagnationDetector,
): Promise<void> {
  steer(agent, steerContent);
  await runStepAgent(agent, REMINDER_PROMPT, cfg, stagnationDetector);
}

/**
 * The nudge-round choreography of the complete() exit protocol (round-5,
 * candidate 5): while not captured, remind; once captured, validate — one
 * repair round per call. Stops when the capture is accepted, when no
 * progress is made, or when maxRounds is hit. Callers own the capture
 * predicate and all steer texts; the rounds themselves live here and
 * nowhere else (previously runReasonAttempt hand-rolled two near-identical
 * copies with an A/B repair-chance asymmetry).
 */
async function captureRounds(
  agent: Agent,
  cfg: RunConfig,
  stagnationDetector: StagnationDetector,
  options: DriveUntilCompleteOptions,
): Promise<void> {
  const maxRounds = options.maxRounds ?? 1;
  for (let round = 0; round < maxRounds; round++) {
    if (!options.hasCaptured()) {
      const text = typeof options.reminderSteer === 'function' ? options.reminderSteer(round) : options.reminderSteer;
      await redrive(agent, text, cfg, stagnationDetector);
      if (!options.hasCaptured()) return; // no progress — stop
      continue;
    }
    const repair = options.validate?.() ?? null;
    if (repair === null) return;
    await redrive(agent, repair, cfg, stagnationDetector);
    return; // exactly one repair chance per call
  }
}

/**
 * The complete() exit protocol: prompt, then nudge rounds until captured
 * (and valid, when a validate option is given).
 */
export async function driveUntilComplete(
  agent: Agent,
  input: string,
  cfg: RunConfig,
  stagnationDetector: StagnationDetector,
  options: DriveUntilCompleteOptions,
): Promise<void> {
  await runStepAgent(agent, input, cfg, stagnationDetector);
  await captureRounds(agent, cfg, stagnationDetector, options);
}

/**
 * The production StepAgentDriver: buildStepAgent + subscribeStepEvents
 * (builder.ts) for construction and wiring, driveUntilComplete for the exit
 * protocol. runStep consumes cfg.stepDriver ?? defaultStepDriver — tests
 * replace the whole collaborator through that seam (round-4, candidate 5).
 */
export const defaultStepDriver: StepAgentDriver = {
  buildAgent(input) {
    const agent = buildStepAgent(
      input.systemPrompt,
      input.initialMessages,
      input.cfg,
      input.onEvent,
      input.tools,
      input.readFiles,
    );
    subscribeStepEvents(agent, input.state, input.stagnationDetector, input.cfg, {
      onLlmText: input.onLlmText,
      onEvent: input.onEvent,
      onTurnEndComplete: input.onTurnEndComplete,
    });
    return agent;
  },
  driveUntilComplete,
};

export interface ReasonAttemptOptions {
  onEvent?: (event: ExecutionEvent) => void;
  onNeedsClarify?: (questions: string[]) => Promise<string>;
  /** Emit a state_change(from -> REASON) event before prompting. */
  fromState?: RunPhase;
  memoryIndex?: string;
  memorySearchTool?: AgentTool;
  /**
   * Throw instead of returning { steps: [] } when the attempt never produces
   * a valid plan (sampler semantics: the sample counts as failed).
   */
  throwOnFailure?: boolean;
}

/**
 * Run one REASON planning attempt: build the agent, prompt, and drive the
 * complete() capture with REMINDER retries and optional clarification.
 * The single implementation behind both the real REASON step and Heavy
 * Thinking samples (which run it with a cloned state machine and
 * throwOnFailure) — the two can no longer drift.
 */
export async function runReasonAttempt(
  mission: Mission,
  cfg: RunConfig,
  conversationHistory: AgentMessage[],
  options: ReasonAttemptOptions = {},
): Promise<{ steps: StepDirective[] }> {
  const { onEvent, onNeedsClarify, fromState, memoryIndex, memorySearchTool, throwOnFailure } = options;
  cfg.stateMachine.transitionTo(State.REASON);

  // Per-step spread: retry-temperature escalation mutates THIS copy via the
  // streamFn closure, never the shared RunConfig (C14).
  const stepCfg = { ...cfg };
  const systemPrompt = buildSystemPrompt({
    state: State.REASON,
    task: mission.description,
    modelParams: cfg.stateMachine.getModelParams(),
    env: cfg.env,
    memoryIndex,
  });

  const stagnationDetector = new StagnationDetector();
  const capture = new CompleteCapture(State.REASON);

  const extraTools: AgentTool[] = memorySearchTool ? [memorySearchTool] : [];
  // REASON builds and drives through the same StepAgentDriver seam as every
  // other step (round-5, candidate 5) — previously it bypassed the seam its
  // own module defines.
  const driver = cfg.stepDriver ?? defaultStepDriver;
  const agent = driver.buildAgent({
    systemPrompt,
    initialMessages: conversationHistory,
    state: State.REASON,
    cfg: stepCfg,
    tools: [capture.tool, ...extraTools],
    stagnationDetector,
    onEvent,
  });

  cfg.registerAgent?.(agent);
  try {
    if (fromState !== undefined) {
      onEvent?.({ type: 'state_change', from: fromState, to: State.REASON });
    }
    await driver.driveUntilComplete(agent, mission.description, stepCfg, stagnationDetector, {
      hasCaptured: () => capture.captured(),
      reminderSteer: '[REMINDER] You must call complete() to submit your execution plan.',
    });

    // Clarification is conversation, not capture protocol — stays here.
    const firstCapture = capture.peek();
    if (firstCapture !== null && firstCapture['needsClarify'] === true && onNeedsClarify) {
      const questions = Array.isArray(firstCapture['questions']) ? (firstCapture['questions'] as string[]) : [];
      const answer = await onNeedsClarify(questions);
      capture.reset();
      await redrive(
        agent,
        `User answered: "${answer}". Now call complete(steps=[...]) with your updated execution plan. steps can be [] for direct Q&A.`,
        stepCfg,
        stagnationDetector,
      );
    }

    // Capture-and-validate rounds (parse-repair / missing-error), INSIDE the
    // registered window so abort (ESC) reaches these runs too (round-4 fix).
    // A/B aligned (round-5): a plan captured on the error round now earns the
    // same single repair chance as one captured on the first drive.
    await captureRounds(agent, stepCfg, stagnationDetector, {
      hasCaptured: () => capture.captured(),
      reminderSteer:
        '[ERROR] You did not call complete(). You MUST call complete(steps=[...]) now to submit your plan.',
      validate: () => {
        const c = capture.peek();
        if (c === null || c['needsClarify'] === true) return null;
        const { error } = parseDirectives(c);
        if (!error) return null;
        capture.reset(); // fresh attempt
        return `[ERROR] complete() was called but the plan is invalid. ${error} Fix and call complete() again with valid steps.`;
      },
      maxRounds: 2,
    });

    // Final parse after the rounds.
    let lastParseError: string | null = null;
    const finalCapture = capture.peek();
    if (finalCapture !== null) {
      if (finalCapture['needsClarify'] === true) {
        return { steps: [] };
      }
      const { steps, error } = parseDirectives(finalCapture);
      if (!error) {
        return { steps };
      }
      lastParseError = error;
    }

    if (throwOnFailure) {
      throw new Error(`bare sample: ${lastParseError ?? 'complete() not called'}`);
    }
    return { steps: [] };
  } finally {
    cfg.unregisterAgent?.(agent);
  }
}
