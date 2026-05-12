import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentEvent } from '@mariozechner/pi-agent-core';
import { streamSimple } from '@mariozechner/pi-ai';
import type { Model } from '@mariozechner/pi-ai';
import { codingTools } from '@mariozechner/pi-coding-agent';
import { StateMachineAgent } from './session.js';
import { State, type StateResult } from './types.js';
import { TaskDecomposer } from './decomposer.js';
import { PromptBuilder } from '../provider/prompt.js';

export type ExecutionEvent =
  | { type: 'state_change'; from: string; to: string }
  | { type: 'tool_call'; tool: string }
  | { type: 'llm_call'; promptLen: number; responseLen: number };

export interface Task {
  id: string;
  description: string;
  state: 'pending' | 'running' | 'completed' | 'failed';
  result?: StateResult;
}

function buildModel(modelName: string, provider: string, baseUrl: string): Model<'openai-completions'> {
  const apiBase = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
  return {
    id: modelName,
    name: modelName,
    api: 'openai-completions',
    provider,
    baseUrl: apiBase,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
  };
}

export class TaskScheduler {
  private tasks: Task[];
  private currentTaskIndex: number;
  private decomposer: TaskDecomposer;

  constructor() {
    this.tasks = [];
    this.currentTaskIndex = 0;
    this.decomposer = new TaskDecomposer();
  }

  async decompose(taskDescription: string): Promise<Task[]> {
    const result = this.decomposer.decompose(taskDescription);
    this.tasks = result.tasks.map((sub) => ({
      id: sub.id,
      description: sub.description,
      state: 'pending' as const,
    }));
    return this.tasks;
  }

  getTasks(): Task[] {
    return this.tasks;
  }

  async executeTask(
    task: Task,
    modelName: string,
    provider: string,
    baseUrl: string,
    onEvent?: (event: ExecutionEvent) => void,
  ): Promise<StateResult> {
    task.state = 'running';

    const stateMachine = new StateMachineAgent(modelName);
    const promptBuilder = new PromptBuilder();
    const model = buildModel(modelName, provider, baseUrl);

    const systemPrompt = promptBuilder.buildSystemPrompt({
      state: State.ANALYZE,
      task: task.description,
      modelParams: stateMachine.getModelParams(),
    });

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools: codingTools,
      },
      streamFn: async (m, ctx, opts) => {
        return streamSimple(m, ctx, { ...opts, apiKey: 'ollama' });
      },
      getApiKey: () => 'ollama',

      beforeToolCall: async (ctx) => {
        const allowedTools = stateMachine.getAllowedTools().map((t) => t.name);
        const toolName = ctx.toolCall.name;
        if (!allowedTools.includes(toolName)) {
          return {
            block: true,
            reason: `State ${stateMachine.getCurrentState()} does not allow tool '${toolName}'. Allowed: ${allowedTools.join(', ')}`,
          };
        }
        return undefined;
      },
    });

    let turnCount = 0;
    const maxTurnsPerState = 5;
    const maxTotalTurns = 25;

    agent.subscribe((event: AgentEvent) => {
      if (event.type === 'tool_execution_start') {
        onEvent?.({ type: 'tool_call', tool: event.toolName });
        stateMachine.recordToolCall(event.toolName, event.args, null);
      }

      if (event.type === 'turn_end') {
        turnCount++;
        onEvent?.({ type: 'llm_call', promptLen: 0, responseLen: 0 });

        const prevState = stateMachine.getCurrentState();
        if (prevState === State.DONE) return;

        stateMachine.incrementIteration();

        const shouldAdvance =
          stateMachine.getIteration() >= maxTurnsPerState || turnCount >= maxTotalTurns;

        if (shouldAdvance) {
          const nextState = advanceState(prevState);
          if (nextState !== prevState) {
            stateMachine.transitionTo(nextState);
            onEvent?.({ type: 'state_change', from: prevState, to: nextState });

            if (nextState !== State.DONE) {
              const newPrompt = promptBuilder.buildSystemPrompt({
                state: nextState,
                task: task.description,
                modelParams: stateMachine.getModelParams(),
              });
              agent.setSystemPrompt(newPrompt);

              agent.steer({
                role: 'user',
                content: [{ type: 'text', text: promptBuilder.buildUserPrompt(nextState, task.description) }],
                timestamp: Date.now(),
              });
            }
          }
        }
      }
    });

    await agent.prompt(task.description);

    const finalState = stateMachine.getCurrentState();
    const agentMessages = agent.state.messages;
    const hadToolCalls = agentMessages.some((m) => m.role === 'toolResult');
    const success = finalState === State.DONE || hadToolCalls || turnCount > 0;

    const result: StateResult = {
      state: finalState,
      success,
      output: 'Task execution completed',
      toolCalls: [],
      nextState: State.DONE,
    };

    task.result = result;
    task.state = success ? 'completed' : 'failed';
    return result;
  }
}

function advanceState(current: State): State {
  const order = [State.ANALYZE, State.LOCATE, State.MODIFY, State.VERIFY, State.DONE];
  const idx = order.indexOf(current);
  return idx >= 0 && idx < order.length - 1 ? order[idx + 1]! : State.DONE;
}
