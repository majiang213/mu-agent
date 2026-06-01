import { StagnationDetector } from '../cognitive/index.js';
import { buildCompleteTool } from '../../tool/complete.js';
import { buildSystemPrompt } from '../prompts/index.js';
import { buildStepAgent, subscribeStepEvents } from '../agent/builder.js';
import { runStepAgent, parseReasonSteps } from '../agent/step-runner.js';
import { State } from '../types.js';
import type { Step } from '../types.js';
import type { RunConfig, Mission, ExecutionEvent } from '../agent/types.js';
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
  onEvent?: (event: ExecutionEvent) => void,
): Promise<PlanCandidate[]> {
  const tier = cfg.stateMachine.getModelParams().tier;
  const count = samplerCfg.planCount ?? (tier === 'SMALL' ? 3 : tier === 'MEDIUM' ? 2 : 1);
  const samplingTemp = samplerCfg.samplingTemperature ?? DEFAULT_SAMPLING_TEMPERATURE;

  let completed = 0;
  const tasks = Array.from({ length: count }, (_, i) => {
    onEvent?.({ type: 'sample_start', index: i, total: count });
    return runBareReasonSample(mission, { ...cfg, temperature: samplingTemp }, conversationHistory, i, onEvent).then(
      (r) => {
        completed++;
        onEvent?.({ type: 'sample_complete', index: i, steps: r.steps });
        onEvent?.({ type: 'sampling_progress', completed, total: count });
        return r;
      },
      () => {
        completed++;
        onEvent?.({ type: 'sample_failed', index: i });
        onEvent?.({ type: 'sampling_progress', completed, total: count });
        return null;
      },
    );
  });

  const results = await Promise.all(tasks);

  return results.flatMap((r, i) => (r !== null ? [{ id: `plan-${i}`, steps: r.steps, sampledAt: Date.now() }] : []));
}

async function runBareReasonSample(
  mission: Mission,
  cfg: RunConfig,
  conversationHistory: AgentMessage[],
  sampleIndex: number,
  onEvent?: (event: ExecutionEvent) => void,
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

  const sampleOnEvent = (event: ExecutionEvent): void => {
    if (event.type === 'message_thinking_update' || event.type === 'message_thinking_end') {
      onEvent?.({ type: 'sample_thinking', index: sampleIndex, content: event.content });
    }
  };

  const stagnationDetector = new StagnationDetector();
  const agent = buildStepAgent(systemPrompt, conversationHistory, isolatedCfg, sampleOnEvent, [completeTool]);
  subscribeStepEvents(agent, State.REASON, stagnationDetector, isolatedCfg, () => {}, sampleOnEvent);

  isolatedCfg.registerAgent?.(agent);
  try {
    await runStepAgent(agent, mission.description, isolatedCfg, stagnationDetector, () => capturedComplete !== null);
  } finally {
    isolatedCfg.unregisterAgent?.(agent);
  }

  if (capturedComplete === null) {
    throw new Error('bare sample: complete() not called');
  }

  const { steps: directives, error } = parseReasonSteps(capturedComplete);
  if (directives.length === 0) {
    throw new Error(`bare sample: invalid plan — ${error ?? 'empty steps'}`);
  }
  const steps: Step[] = directives.flatMap((d) => ('parallel' in d ? d.parallel : [d]));

  return { steps };
}
