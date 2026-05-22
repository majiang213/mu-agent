import type { Agent } from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';
import type { StateMachineAgent } from '../session.js';
import type { EnvContext } from '../prompts/agent.js';
import type { SafetyConfig } from '../../config/types.js';
import type { SafeModifier } from '../../tool/safety/index.js';
import type { LspClient } from '../../tool/lsp.js';

export type ExecutionEvent =
  | { type: 'state_change'; from: string; to: string }
  | { type: 'tool_execution_start'; tool: string; args?: Record<string, unknown> }
  | { type: 'tool_execution_end'; tool: string; isError: boolean }
  | { type: 'message_end'; content: string }
  | { type: 'message_thinking_end'; content: string }
  | { type: 'message_update'; content: string }
  | { type: 'message_thinking_update'; content: string }
  | { type: 'turn_end'; promptLen: number; responseLen: number; contextTokens: number }
  | { type: 'turn_start'; systemPrompt: string; userPrompt: string }
  | { type: 'task_start'; taskIndex: number; taskTotal: number; description: string }
  | { type: 'task_end'; taskIndex: number; taskTotal: number }
  | { type: 'clarification_needed'; questions: string[] };

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
  projectRoot: string;
  registerAgent?: (agent: Agent) => void;
  unregisterAgent?: (agent: Agent) => void;
  lspClient?: LspClient;
}
