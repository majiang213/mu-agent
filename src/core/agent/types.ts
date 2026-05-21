import type { Agent } from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';
import type { StateMachineAgent } from '../session.js';
import type { EnvContext } from '../prompts/agent.js';
import type { SafetyConfig } from '../../config/types.js';
import type { SafeModifier } from '../../tool/safety/index.js';
import type { StateResult } from '../types.js';

export type ExecutionEvent =
  | { type: 'state_change'; from: string; to: string }
  | { type: 'tool_call'; tool: string; args?: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; isError: boolean }
  | { type: 'llm_output'; content: string }
  | { type: 'llm_thinking'; content: string }
  | { type: 'llm_output_delta'; content: string }
  | { type: 'llm_thinking_delta'; content: string }
  | { type: 'llm_call'; promptLen: number; responseLen: number; contextTokens: number }
  | { type: 'llm_prompt'; systemPrompt: string; userPrompt: string }
  | { type: 'task_start'; taskIndex: number; taskTotal: number; description: string }
  | { type: 'task_done'; taskIndex: number; taskTotal: number }
  | { type: 'clarification_needed'; questions: string[] };

export interface Mission {
  id: string;
  description: string;
  state: 'pending' | 'running' | 'completed' | 'failed';
  result?: StateResult;
}

export interface RunConfig {
  model: Model<'openai-completions'>;
  stateMachine: StateMachineAgent;
  safetyConfig: SafetyConfig;
  safeModifier: SafeModifier;
  env: EnvContext;
  temperature: number;
  projectRoot: string;
  registerAgent?: (agent: Agent) => void;
  unregisterAgent?: (agent: Agent) => void;
}
