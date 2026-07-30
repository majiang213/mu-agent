import type { Agent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import { StagnationDetector } from '../cognitive/index.js';
import { retryDelayMs, sleep } from '../failure/index.js';
import { DEFAULT_TEMPERATURE, MAX_TEMPERATURE, RETRY_TEMPERATURE_STEP } from '../../config/defaults.js';
import { buildCompleteTool } from '../../tool/complete.js';
import { buildSystemPrompt } from '../prompts/agent.js';
import { buildStepAgent, subscribeStepEvents } from './builder.js';
import { parseDirectives } from './directives.js';
import { isAbortError } from './abort.js';
import { State } from '../types.js';
import type { StepDirective } from '../types.js';
import type { ExecutionEvent, Mission, RunConfig, RunPhase } from './types.js';

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
  const maxRetries = Math.max(cfg.stateMachine.getModelParams().maxRetries, 3);
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
        cfg.temperature = Math.min(DEFAULT_TEMPERATURE + attempt * RETRY_TEMPERATURE_STEP, MAX_TEMPERATURE);
        stagnationDetector.reset();
        cfg.stateMachine.resetForRetry();
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
  let capturedComplete: Record<string, unknown> | null = null;
  const completeTool = buildCompleteTool(State.REASON, (args) => {
    capturedComplete = args;
  });

  const extraTools: AgentTool[] = memorySearchTool ? [memorySearchTool] : [];
  const agent = buildStepAgent(systemPrompt, conversationHistory, stepCfg, onEvent, [completeTool, ...extraTools]);
  subscribeStepEvents(agent, State.REASON, stagnationDetector, stepCfg, () => {}, onEvent);

  cfg.registerAgent?.(agent);
  try {
    if (fromState !== undefined) {
      onEvent?.({ type: 'state_change', from: fromState, to: State.REASON });
    }
    await runStepAgent(agent, mission.description, stepCfg, stagnationDetector);

    if (capturedComplete === null) {
      agent.steer({
        role: 'steer',
        content: '[REMINDER] You must call complete() to submit your execution plan.',
        timestamp: Date.now(),
      });
      await runStepAgent(agent, '[REMINDER] Call complete() now.', stepCfg, stagnationDetector);
    }

    if (capturedComplete !== null && capturedComplete['needsClarify'] === true && onNeedsClarify) {
      const questions = Array.isArray(capturedComplete['questions']) ? (capturedComplete['questions'] as string[]) : [];
      const answer = await onNeedsClarify(questions);
      capturedComplete = null;
      agent.steer({
        role: 'steer',
        content: `User answered: "${answer}". Now call complete(steps=[...]) with your updated execution plan. steps can be [] for direct Q&A.`,
        timestamp: Date.now(),
      });
      await runStepAgent(agent, '[REMINDER] Call complete() now.', stepCfg, stagnationDetector);
    }
  } finally {
    cfg.unregisterAgent?.(agent);
  }

  let lastParseError: string | null = null;
  if (capturedComplete !== null) {
    const c = capturedComplete;
    if (c['needsClarify'] === true) {
      return { steps: [] };
    }
    const { steps, error } = parseDirectives(c);
    if (!error) {
      return { steps };
    }
    lastParseError = error;
    capturedComplete = null;
    agent.steer({
      role: 'steer',
      content: `[ERROR] complete() was called but the plan is invalid. ${error} Fix and call complete() again with valid steps.`,
      timestamp: Date.now(),
    });
    await runStepAgent(agent, '[REMINDER] Call complete() now.', stepCfg, stagnationDetector);
    if (capturedComplete !== null) {
      const { steps: retrySteps, error: retryError } = parseDirectives(capturedComplete);
      if (!retryError) {
        return { steps: retrySteps };
      }
      lastParseError = retryError;
    }
  } else {
    agent.steer({
      role: 'steer',
      content: '[ERROR] You did not call complete(). You MUST call complete(steps=[...]) now to submit your plan.',
      timestamp: Date.now(),
    });
    await runStepAgent(agent, '[REMINDER] Call complete() now.', stepCfg, stagnationDetector);
    if (capturedComplete !== null) {
      const { steps, error } = parseDirectives(capturedComplete);
      if (!error) {
        return { steps };
      }
      lastParseError = error;
    }
  }

  if (throwOnFailure) {
    throw new Error(`bare sample: ${lastParseError ?? 'complete() not called'}`);
  }
  return { steps: [] };
}
