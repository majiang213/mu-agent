import { Type } from 'typebox';
import { Value } from 'typebox/value';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { State } from '../core/types.js';
import { STATE_REGISTRY } from '../core/state-registry.js';

/**
 * Validate complete() args against the state's TypeBox schema (the same
 * schema the model sees as the tool parameters — one source of truth).
 * The error message pairs the first schema error with the state's
 * human-readable reminderFields so a small model can self-correct.
 */
function validateCompleteArgs(
  state: State,
  schema: ReturnType<typeof Type.Object>,
  args: Record<string, unknown>,
): string | null {
  if (Value.Check(schema, args)) return null;
  const first = [...Value.Errors(schema, args)][0];
  const path = first?.instancePath.replace(/^\//, '') ?? '';
  const detail = first ? `${path || 'args'}: ${first.message}` : 'invalid arguments';
  const required = STATE_REGISTRY[state]?.reminderFields;
  const hint = required ? `Required fields: ${required}.` : 'See system prompt for required fields.';
  return `${state} complete() validation failed — ${detail}. ${hint}`;
}

export function buildCompleteTool(state: State, onComplete: (args: Record<string, unknown>) => void): AgentTool {
  const schema = STATE_REGISTRY[state]?.completeSchema ?? Type.Object({}, { additionalProperties: true });

  return {
    name: 'complete',
    label: 'Complete',
    description: 'Call this when you have finished the task to submit your result.',
    parameters: schema,
    execute: async (_toolCallId, args) => {
      const a = args as Record<string, unknown>;
      const error = validateCompleteArgs(state, schema, a);
      if (error) {
        return { content: [{ type: 'text' as const, text: `Error: ${error}` }], details: undefined };
      }
      onComplete(a);
      return { content: [{ type: 'text' as const, text: 'ok' }], details: undefined };
    },
  };
}

/**
 * The complete() capture protocol's one home (architecture review 2026-08-05,
 * candidate 1). Callers used to re-invent `let capturedComplete = null` +
 * closure + `hasCaptured` predicates at every site (runStep, runReasonAttempt)
 * — the slot, the tool, and the predicate now live behind one interface.
 *
 * Reminder/validate TEXTS stay caller-owned: they are per-state or per-phase
 * policy (REASON's plan reminder differs from a MODIFY step's), not protocol.
 */
export class CompleteCapture {
  private args: Record<string, unknown> | null = null;
  /** The tool to hand to the step agent — captures into this instance. */
  readonly tool: AgentTool;

  constructor(readonly state: State) {
    this.tool = buildCompleteTool(state, (a) => {
      this.args = a;
    });
  }

  /** driveUntilComplete's hasCaptured predicate. */
  captured(): boolean {
    return this.args !== null;
  }

  /** Read the captured args without consuming (post-drive inspection). */
  peek(): Record<string, unknown> | null {
    return this.args;
  }

  /** Drop the capture — a fresh attempt follows (clarify / parse-repair). */
  reset(): void {
    this.args = null;
  }
}

/** The generic per-state reminder steer used when a step ends without complete(). */
export function completeReminder(state: State): string {
  const fields = STATE_REGISTRY[state]?.reminderFields ?? 'see system prompt';
  return `[REMINDER] You must call complete() now. Do NOT output any text — call complete() directly as your only action. Required fields: ${fields}.`;
}
