import { StagnationDetector } from '../cognitive/index.js';
import { buildCompleteTool } from '../../tool/complete.js';
import { buildSystemPrompt } from '../prompts/index.js';
import { buildStepAgent, subscribeStepEvents } from '../agent/builder.js';
import { runStepAgent, parseReasonSteps } from '../agent/step-runner.js';
import { State } from '../types.js';
import type { RunConfig, Mission } from '../agent/types.js';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { PlanCandidate } from './types.js';
import { DEFAULT_SAMPLING_TEMPERATURE } from '../../config/defaults.js';

export interface SamplerConfig {
  planCount?: number;
  samplingTemperature?: number;
}

export async function samplePlans(
  mission: Mission,
  cfg: RunConfig,
  conversationHistory: AgentMessage[],
  samplerCfg: SamplerConfig = {},
): Promise<PlanCandidate[]> {
  const tier = cfg.stateMachine.getModelParams().tier;
  const count = samplerCfg.planCount ?? (tier === 'SMALL' ? 3 : tier === 'MEDIUM' ? 2 : 1);
  const samplingTemp = samplerCfg.samplingTemperature ?? DEFAULT_SAMPLING_TEMPERATURE;

  const tasks = Array.from({ length: count }, () =>
    runBareReasonSample(mission, { ...cfg, temperature: samplingTemp }, conversationHistory),
  );

  const results = await Promise.allSettled(tasks);

  return results.flatMap((r, i) =>
    r.status === 'fulfilled' ? [{ id: `plan-${i}`, steps: r.value.steps, sampledAt: Date.now() }] : [],
  );
}

async function runBareReasonSample(
  mission: Mission,
  cfg: RunConfig,
  conversationHistory: AgentMessage[],
): Promise<{ steps: PlanCandidate['steps'] }> {
  const isolatedCfg = { ...cfg, stateMachine: cfg.stateMachine.clone() };
  isolatedCfg.stateMachine.transitionTo(State.REASON);
  const systemPrompt = buildSystemPrompt({
    state: State.REASON,
    task: mission.description,
    modelParams: isolatedCfg.stateMachine.getModelParams(),
    env: isolatedCfg.env,
  });

  let capturedComplete: Record<string, unknown> | null = null;
  const completeTool = buildCompleteTool(State.REASON, (args) => {
    capturedComplete = args;
  });

  const stagnationDetector = new StagnationDetector();
  const agent = buildStepAgent(systemPrompt, conversationHistory, isolatedCfg, undefined, [completeTool]);
  subscribeStepEvents(agent, State.REASON, stagnationDetector, isolatedCfg, () => {}, undefined);

  isolatedCfg.registerAgent?.(agent);
  try {
    await runStepAgent(agent, mission.description, isolatedCfg, stagnationDetector, () => capturedComplete !== null);
  } finally {
    isolatedCfg.unregisterAgent?.(agent);
  }

  if (capturedComplete === null) {
    throw new Error('bare sample: complete() not called');
  }

  const { steps, error } = parseReasonSteps(capturedComplete);
  if (steps.length === 0) {
    throw new Error(`bare sample: invalid plan — ${error ?? 'empty steps'}`);
  }

  return { steps };
}
