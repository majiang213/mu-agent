import type { Agent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import type { Model, Models } from '@earendil-works/pi-ai';
import type { ExtensionRunner } from '@earendil-works/pi-coding-agent';
import type { StateMachineAgent } from './state-machine.js';
import type { StagnationDetector } from '../cognitive/index.js';
import type { EnvContext } from '../prompts/agent.js';
import type { SafetyConfig, HeavyThinkingConfig, ExtensionsConfig } from '../../config/types.js';
import type { ExtensionHostState } from '../extensions/host-actions.js';
import type { SafeModifier } from '../../tool/safety/checkpoint.js';
import type { LspClient } from '../../tool/lsp.js';
import type { CodeGraphLocator } from '../graph/locator.js';
import type { State } from '../types.js';

/**
 * Run lifecycle phases reported via state_change: every real State plus the
 * two harness phases that are not States — IDLE (before the first REASON)
 * and SAMPLING (Heavy Thinking). Declared here so the TUI special-cases
 * declared vocabulary instead of names core smuggled through a bare string.
 */
export type RunPhase = State | 'IDLE' | 'SAMPLING';

export type ExecutionEvent =
  | { type: 'state_change'; from: RunPhase; to: RunPhase }
  /** Rollback restored files — a harness action, not a model tool call. */
  | { type: 'rollback_performed'; files: string[] }
  | { type: 'tool_execution_start'; tool: string; toolId: string; args?: Record<string, unknown> }
  | { type: 'tool_execution_end'; tool: string; toolId: string; isError: boolean; output?: string }
  | { type: 'session_info'; provider: string; tier: 'SMALL' | 'MEDIUM' | 'LARGE'; contextWindow: number }
  | { type: 'message_end'; content: string }
  | { type: 'message_thinking_end'; content: string }
  | { type: 'message_update'; content: string }
  | { type: 'message_thinking_update'; content: string }
  | { type: 'turn_end'; promptLen: number; responseLen: number }
  | { type: 'turn_start'; systemPrompt: string; userPrompt: string }
  | { type: 'task_start'; taskIndex: number; taskTotal: number; description: string }
  | { type: 'task_end'; taskIndex: number; taskTotal: number }
  | { type: 'clarification_needed'; questions: string[] }
  | { type: 'deliberation_start' }
  | { type: 'sample_start'; index: number }
  | { type: 'sample_thinking'; index: number; content: string }
  | { type: 'sample_complete'; index: number; steps: import('../types.js').StepDirective[] }
  | { type: 'sample_failed'; index: number }
  | { type: 'deliberation_refinement'; round: number; verdict: 'BETTER' | 'WORSE' | 'SAME' | 'converged' }
  | { type: 'deliberation_complete'; synthesizedStepCount: number; summary: string }
  | { type: 'deliberation_fallback'; reason: string }
  | { type: 'deliberation_clarification'; question: string }
  | { type: 'parallel_start'; stepCount: number }
  | { type: 'parallel_complete'; stepCount: number }
  | { type: 'parallel_overlap'; files: string[] }
  | { type: 'sampling_expand'; round: number; reason: 'divergent' }
  | { type: 'sampling_stopped'; reason: 'converged' | 'max_count' | 'max_rounds' | 'no_new_info' }
  | { type: 'subplan_start'; analyzerState: string; focus: string }
  | { type: 'subplan_complete'; subStepCount: number }
  | { type: 'plan_parse_error'; analyzerState: string; output: string }
  /** Extension subsystem message: load errors, handler failures, unsupported-API warnings (Gap 85-A). */
  | { type: 'extension_notify'; message: string; level: 'info' | 'warning' | 'error' };

export interface Mission {
  id: string;
  description: string;
  state: 'running' | 'completed' | 'failed';
}

/** Options threaded through step execution. */
export interface StepRunOptions {
  onEvent?: (event: ExecutionEvent) => void;
  memoryIndex?: string;
  memorySearchTool?: AgentTool;
}

export interface ReasonStepOptions extends StepRunOptions {
  onNeedsClarify?: (questions: string[]) => Promise<string>;
}

/** Everything needed to build and wire one step's Agent (StepAgentDriver). */
export interface StepAgentBuildInput {
  systemPrompt: string;
  initialMessages: AgentMessage[];
  state: State;
  cfg: RunConfig;
  tools: AgentTool[];
  readFiles?: Set<string>;
  stagnationDetector: StagnationDetector;
  /** Optional since round 5 — REASON builds through the same seam and ignores llm text. */
  onLlmText?: (text: string) => void;
  onEvent?: (event: ExecutionEvent) => void;
  onTurnEndComplete?: () => void;
}

export interface DriveUntilCompleteOptions {
  /** True once the state's complete() tool call has been captured. */
  hasCaptured: () => boolean;
  /** Per-state steer guidance for a no-capture round (a function may vary it per round). */
  reminderSteer: string | ((round: number) => string);
  /**
   * After a capture: return a repair steer message to re-drive once, or null
   * to accept. May reset the capture first (fresh attempt). REASON wraps
   * parseDirectives with this (round-5, candidate 5) — "captured AND valid"
   * is driver's business, not two hand-rolled copies in the caller.
   */
  validate?: () => string | null;
  /** Cap on nudge rounds (reminder + one repair max per call site). */
  maxRounds?: number;
}

/**
 * The one collaborator runStep orchestrates (round-4, candidate 5): build a
 * wired step agent, then drive it until complete() is captured. Tests fake
 * this seam instead of mocking the module graph (builder / prompts /
 * cognitive / locator …). The default implementation composes builder.ts +
 * the driver functions in reason-runner.ts (see defaultStepDriver).
 */
export interface StepAgentDriver {
  buildAgent(input: StepAgentBuildInput): Agent;
  driveUntilComplete(
    agent: Agent,
    input: string,
    cfg: RunConfig,
    stagnationDetector: StagnationDetector,
    options: DriveUntilCompleteOptions,
  ): Promise<void>;
}

/**
 * RunConfig role slices (architecture review 2026-08-05, candidate 4).
 * RunConfig composes them — fields stay flat, so no consumer changes — but
 * the roles are now NAMED and type-checked: a function that only reaches the
 * LLM can take ModelAccess, a test can build RunServices alone, and the
 * grab-bag's ownership boundaries are vocabulary instead of a comment.
 */

/** Model access slice — everything about reaching the LLM. */
export interface ModelAccess {
  model: Model<'openai-completions'>;
  /** pi-ai Models collection (Gap 89) — all LLM calls go models.streamSimple/completeSimple. */
  models: Models;
  /**
   * Base temperature for every step. Retry escalation (escalatedTemperature,
   * defaults.ts) writes to the per-step spread, never the shared config (C14).
   */
  temperature: number;
  contextRatio: number;
  apiKey: string;
}

/**
 * Immutable services slice — shared by reference across the whole run. The
 * safeModifier checkpoint store is shared even by parallel branches;
 * stateMachine is the one service cloned per branch (fork semantics live
 * in step-context.ts).
 */
export interface RunServices {
  stateMachine: StateMachineAgent;
  safeModifier: SafeModifier;
  lspClient?: LspClient;
  /**
   * One locator per run (BM25 cache survives across steps); built by
   * buildRunSetup and closed at cleanup. Explicitly nullable — tests pass
   * null for "no graph". Never lazily memoized by steps (the old ??=
   * fallback mutated this read-only object; round-4, candidate 6).
   */
  locator: CodeGraphLocator | null;
}

/** Lifecycle hooks slice — optional callbacks + the step-driver test seam. */
export interface RunHooks {
  registerAgent?: (agent: Agent) => void;
  unregisterAgent?: (agent: Agent) => void;
  /** Test seam: replace runStep's build+drive collaborator (default: defaultStepDriver). */
  stepDriver?: StepAgentDriver;
}

/**
 * Everything a run needs (built once by buildRunSetup): the three role
 * slices above, flattened, plus the per-run settings below — read-only after
 * setup. Steps NEVER mutate this object: runStep / runReasonAttempt spread it
 * before building their agent, so retry-temperature escalation writes to a
 * step-local copy (see runStepAgent; C14).
 */
export interface RunConfig extends ModelAccess, RunServices, RunHooks {
  // ── per-run settings ──
  safetyConfig: SafetyConfig;
  env: EnvContext;
  projectRoot: string;
  heavyThinking?: HeavyThinkingConfig;
  /**
   * Loaded extension runner (Gap 85-A) — undefined when extensions are
   * disabled or none were discovered. All interception points short-circuit
   * on undefined/hasHandlers, so the zero-extension run costs nothing.
   */
  extensionRunner?: ExtensionRunner;
  /** Live host state shared with the extension runtime (abort fan-out, system prompt, notify sink). */
  extensionHost?: ExtensionHostState;
  /** Resolved extensions config (toolStates allowlist for extension tools). */
  extensionsConfig?: ExtensionsConfig;
}
