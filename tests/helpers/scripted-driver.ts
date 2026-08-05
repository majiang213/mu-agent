import { vi } from 'vitest';
import type { Agent } from '@earendil-works/pi-agent-core';
import type { RunConfig, StepAgentBuildInput } from '../../src/core/agent/types.js';

/**
 * A StepAgentDriver that plays the model from a script (round-8, candidate 2).
 * Each driveUntilComplete call shifts the next entry:
 *   - Error → throw it (the step's LLM call failed);
 *   - null → the model never calls complete() (llm-text-only fallback path);
 *   - payload object → execute the step's REAL complete() tool with it,
 *     exactly what the model's tool call does (schema validation included).
 * The pipeline (runStep / executeSteps / runReasonAttempt / runWithVerifyRetry
 * / ReactAgent.run) runs real — only the model is scripted. Replaces the
 * step-runner.js / builder.js module mocks, which faked the same boundary
 * through the module graph instead of the seam built for it.
 *
 * Parallel branches drive in build order (runStep reaches its first await
 * synchronously per branch), so script order is deterministic.
 */
export type ScriptEntry = Record<string, unknown> | Error | null;

export interface ScriptedDriver {
  driver: NonNullable<RunConfig['stepDriver']>;
  /** Every agent the driver built, in build order (prompt/steer spies). */
  agents: Array<{ prompt: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn> }>;
}

export function makeScriptedDriver(script: ScriptEntry[]): ScriptedDriver {
  const queue = [...script];
  const agents: ScriptedDriver['agents'] = [];
  const toolsByAgent = new Map<object, StepAgentBuildInput['tools']>();
  const driver: NonNullable<RunConfig['stepDriver']> = {
    buildAgent: vi.fn((input: StepAgentBuildInput) => {
      const agent = { prompt: vi.fn(async () => {}), steer: vi.fn(), on: vi.fn(), off: vi.fn(), abort: vi.fn() };
      agents.push(agent);
      toolsByAgent.set(agent, input.tools);
      return agent as unknown as Agent;
    }),
    driveUntilComplete: vi.fn(async (agent: Agent) => {
      const entry = queue.shift();
      if (entry === undefined) {
        throw new Error('scripted driver: script exhausted — the pipeline ran more steps than scripted');
      }
      if (entry === null) return; // model ended without calling complete()
      if (entry instanceof Error) throw entry;
      const completeTool = toolsByAgent.get(agent)?.find((t) => t.name === 'complete');
      if (!completeTool) throw new Error('scripted driver: no complete tool in the build input');
      const result = await completeTool.execute('scripted', entry, {} as never);
      // A schema rejection is a script bug (payload doesn't match the state's
      // completeSchema) — surface it loudly instead of looping reminders.
      // To script "the model sent invalid args", use null (no capture).
      const first = result.content[0];
      const text = first?.type === 'text' ? first.text : '';
      if (text.startsWith('Error:')) {
        throw new Error(`scripted driver: complete() payload rejected — ${text}`);
      }
    }),
  };
  return { driver, agents };
}
