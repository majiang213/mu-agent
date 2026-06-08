import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { State } from '../core/types.js';

const COMPLETE_SCHEMAS: Partial<Record<State, ReturnType<typeof Type.Object>>> = {
  [State.REASON]: Type.Object({
    steps: Type.Array(
      Type.Union([
        Type.Object({
          state: Type.String({ description: 'State name, e.g. LOCATE, MODIFY, VERIFY, ANSWER, RESEARCH' }),
          focus: Type.String({ description: 'What to do in this step' }),
          why: Type.Optional(
            Type.String({
              description: 'In max 15 words: why this step and why this approach. Skip for obvious steps.',
            }),
          ),
        }),
        Type.Object({
          parallel: Type.Array(
            Type.Object({
              state: Type.String({ description: 'State name for this parallel step' }),
              focus: Type.String({ description: 'What to do in this parallel step' }),
              why: Type.Optional(Type.String({ description: 'In max 15 words: why this step.' })),
            }),
            { description: 'Array of independent steps to execute concurrently', minItems: 2 },
          ),
        }),
      ]),
    ),
    needsClarify: Type.Boolean(),
    questions: Type.Optional(Type.Array(Type.String())),
  }),

  [State.CLARIFY]: Type.Object({
    questions: Type.Array(Type.String({ description: 'Question to ask the user' })),
  }),

  [State.LOCATE]: Type.Object({
    locations: Type.Array(
      Type.Object({
        file: Type.String(),
        startLine: Type.Number(),
        endLine: Type.Number(),
        snippet: Type.String({ description: 'Current code at this location' }),
      }),
    ),
  }),

  [State.MODIFY]: Type.Object({
    edited: Type.Array(Type.String({ description: 'File path that was modified' })),
    linesChanged: Type.Number(),
  }),

  [State.VERIFY]: Type.Object({
    passed: Type.Boolean(),
    issues: Type.Array(Type.String()),
    summary: Type.String(),
  }),

  [State.ANSWER]: Type.Object({
    answer: Type.String({ description: 'Your answer to the user' }),
  }),

  [State.DIAGNOSE]: Type.Object({
    rootCause: Type.String(),
    location: Type.String({ description: 'file:line where the bug is' }),
    fix: Type.String({ description: 'Suggested fix' }),
  }),

  [State.REVIEW]: Type.Object({
    issues: Type.Array(Type.String()),
    suggestions: Type.Array(Type.String()),
    verdict: Type.Union([Type.Literal('pass'), Type.Literal('fail')]),
  }),

  [State.TEST_WRITE]: Type.Object({
    testFile: Type.String(),
    cases: Type.Number({ description: 'Number of test cases written' }),
  }),

  [State.REFACTOR_PLAN]: Type.Object({
    refactorSteps: Type.Array(Type.String()),
    estimatedFiles: Type.Number(),
  }),

  [State.RUN]: Type.Object({
    exitCode: Type.Number(),
    summary: Type.String({ description: 'Key output or what happened' }),
  }),

  [State.RESEARCH]: Type.Object({
    report: Type.String({ description: 'Your findings, cite file paths or URLs' }),
  }),

  [State.SETUP]: Type.Object({
    created: Type.String({ description: 'File that was created or updated' }),
    summary: Type.String(),
  }),

  [State.ROLLBACK]: Type.Object({
    restored: Type.Array(Type.String({ description: 'File path that was restored' })),
  }),
};

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
  }
  return null;
}

export function buildCompleteTool(state: State, onComplete: (args: Record<string, unknown>) => void): AgentTool {
  const schema = COMPLETE_SCHEMAS[state] ?? Type.Object({}, { additionalProperties: true });

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
