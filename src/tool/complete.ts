import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { State } from '../core/types.js';
import { STATE_REGISTRY } from '../core/state-registry.js';

function validateCompleteArgs(state: State, args: Record<string, unknown>): string | null {
  switch (state) {
    case State.REASON:
      if (!Array.isArray(args['steps']))
        return 'steps must be an array (can be empty for direct Q&A). Set needsClarify=true with questions if intent is unclear.';
      break;
    case State.LOCATE:
      if (!Array.isArray(args['locations']) || (args['locations'] as unknown[]).length === 0)
        return 'locations must be a non-empty array. Read the relevant files first.';
      break;
    case State.MODIFY:
      if (!Array.isArray(args['edited']) || (args['edited'] as unknown[]).length === 0)
        return 'edited must be a non-empty array of modified file paths.';
      break;
    case State.ANSWER:
      if (!args['answer'] || typeof args['answer'] !== 'string' || !(args['answer'] as string).trim())
        return 'answer must be a non-empty string.';
      break;
    case State.DIAGNOSE:
      if (!args['rootCause'] || typeof args['rootCause'] !== 'string' || !(args['rootCause'] as string).trim())
        return 'rootCause must be a non-empty string.';
      break;
    case State.RESEARCH:
      if (!args['report'] || typeof args['report'] !== 'string' || !(args['report'] as string).trim())
        return 'report must be a non-empty string.';
      break;
    case State.WRITE:
      if (!Array.isArray(args['createdFiles']) || (args['createdFiles'] as unknown[]).length === 0)
        return 'createdFiles must be a non-empty array. Call write() to create the file first.';
      break;
    case State.PLAN:
      if (!Array.isArray(args['steps']) || (args['steps'] as unknown[]).length === 0)
        return 'steps must be a non-empty array. Inspect the codebase first, then plan at least one step.';
      break;
  }
  return null;
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
      const error = validateCompleteArgs(state, a);
      if (error) {
        return { content: [{ type: 'text' as const, text: `Error: ${error}` }], details: undefined };
      }
      onComplete(a);
      return { content: [{ type: 'text' as const, text: 'ok' }], details: undefined };
    },
  };
}
