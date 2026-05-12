import { StateMachineAgent } from './session.js';
import { State, type StateResult } from './types.js';
import { LLMService } from '../provider/llm-service.js';
import { TaskDecomposer } from './decomposer.js';

export type ExecutionEvent =
  | { type: 'state_change'; from: string; to: string }
  | { type: 'tool_call'; tool: string }
  | { type: 'llm_call'; promptLen: number; responseLen: number };

/**
 * Task scheduler for level 1 decomposition
 */
export interface Task {
  id: string;
  description: string;
  state: 'pending' | 'running' | 'completed' | 'failed';
  result?: StateResult;
}

/**
 * Task scheduler
 */
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

  /**
   * Execute task through state machine
   */
  async executeTask(
    task: Task,
    modelName: string,
    provider: string,
    baseUrl: string,
    onEvent?: (event: ExecutionEvent) => void,
  ): Promise<StateResult> {
    task.state = 'running';

    const stateMachine = new StateMachineAgent(modelName);
    const llmService = new LLMService(provider, modelName, baseUrl);

    let currentState = stateMachine.getCurrentState();
    const maxTotalIterations = 50;
    let totalIterations = 0;

    while (currentState !== State.DONE && totalIterations < maxTotalIterations) {
      const context = stateMachine.createContext(task.description);
      const prompt = stateMachine.generatePrompt(task.description);

      const { content, toolCalls } = await llmService.generate(context, prompt);
      onEvent?.({ type: 'llm_call', promptLen: prompt.length, responseLen: content.length });

      for (const call of toolCalls) {
        stateMachine.recordToolCall(call.tool, call.input, call.output);
        onEvent?.({ type: 'tool_call', tool: call.tool });
      }

      const exitCheck = stateMachine.checkExit(content);

      if (exitCheck.shouldExit) {
        const prevState = stateMachine.getCurrentState();
        stateMachine.transitionTo(exitCheck.nextState);
        currentState = stateMachine.getCurrentState();
        onEvent?.({ type: 'state_change', from: prevState, to: currentState });
      } else {
        stateMachine.incrementIteration();
      }

      totalIterations++;
    }

    const result: StateResult = {
      state: currentState,
      success: currentState === State.DONE,
      output: 'Task execution completed',
      toolCalls: [],
      nextState: State.DONE,
    };

    task.result = result;
    task.state = result.success ? 'completed' : 'failed';

    return result;
  }

  /**
   * Get all tasks
   */
  getTasks(): Task[] {
    return this.tasks;
  }

  /**
   * Get current task
   */
  getCurrentTask(): Task | undefined {
    return this.tasks[this.currentTaskIndex];
  }
}
