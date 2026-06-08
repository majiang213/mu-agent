import type { Agent } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import type { StateMachineAgent } from '../session/index.js';
import type { EnvContext } from '../prompts/agent.js';
import type { SafetyConfig, HeavyThinkingConfig } from '../../config/types.js';
import type { SafeModifier } from '../../tool/safety/index.js';
import type { LspClient } from '../../tool/lsp.js';

export type ExecutionEvent =
  | { type: 'state_change'; from: string; to: string }
  | { type: 'tool_execution_start'; tool: string; toolId: string; args?: Record<string, unknown> }
  | { type: 'tool_execution_end'; tool: string; toolId: string; isError: boolean; output?: string }
  | { type: 'session_info'; provider: string; tier: 'SMALL' | 'MEDIUM' | 'LARGE'; contextWindow: number }
  | { type: 'message_end'; content: string }
  | { type: 'message_thinking_end'; content: string }
  | { type: 'message_update'; content: string }
  | { type: 'message_thinking_update'; content: string }
  | { type: 'turn_end'; promptLen: number; responseLen: number; contextTokens: number }
  | { type: 'turn_start'; systemPrompt: string; userPrompt: string }
  | { type: 'task_start'; taskIndex: number; taskTotal: number; description: string }
  | { type: 'task_end'; taskIndex: number; taskTotal: number }
  | { type: 'clarification_needed'; questions: string[] }
  | { type: 'deliberation_start'; candidateCount: number }
  | { type: 'sample_start'; index: number; total: number }
  | { type: 'sample_thinking'; index: number; content: string }
  | { type: 'sample_complete'; index: number; steps: import('../types.js').Step[] }
  | { type: 'sample_failed'; index: number }
  | { type: 'sampling_progress'; completed: number; total: number }
  | { type: 'deliberation_refinement'; round: number; verdict: 'BETTER' | 'WORSE' | 'SAME' | 'converged' }
  | { type: 'deliberation_complete'; synthesizedStepCount: number; summary: string }
  | { type: 'deliberation_fallback'; reason: string }
  | { type: 'deliberation_clarification'; question: string }
  | { type: 'parallel_start'; stepCount: number }
  | { type: 'parallel_complete'; stepCount: number }
  | { type: 'sampling_expand'; round: number; reason: 'divergent' }
  | { type: 'sampling_stopped'; reason: 'converged' | 'max_count' | 'max_rounds' | 'no_new_info' };

export interface Mission {
  id: string;
  description: string;
  state: 'pending' | 'running' | 'completed' | 'failed';
}

export interface RunConfig {
  model: Model<'openai-completions'>;
  stateMachine: StateMachineAgent;
  safetyConfig: SafetyConfig;
  safeModifier: SafeModifier;
  env: EnvContext;
  temperature: number;
  contextRatio: number;
  apiKey: string;
  projectRoot: string;
  registerAgent?: (agent: Agent) => void;
  unregisterAgent?: (agent: Agent) => void;
  lspClient?: LspClient;
  heavyThinking?: HeavyThinkingConfig;
}
