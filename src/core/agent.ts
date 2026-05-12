import { StateMachineAgent } from './session.js';
import { State, type StateResult } from './types.js';
import { LLMService } from '../provider/llm-service.js';

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

  constructor() {
    this.tasks = [];
    this.currentTaskIndex = 0;
  }

  /**
   * Decompose high-level task into subtasks
   */
  async decompose(taskDescription: string): Promise<Task[]> {
    // Level 1: Simple decomposition for now
    // In production, this would use LLM to decompose
    this.tasks = [
      {
        id: '1',
        description: taskDescription,
        state: 'pending',
      },
    ];
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

      // Generate LLM response
      const { content, toolCalls } = await llmService.generate(context, prompt);

      // Record tool calls
      for (const call of toolCalls) {
        stateMachine.recordToolCall(call.tool, call.input, call.output);
      }

      // Check exit condition
      const exitCheck = stateMachine.checkExit(content);

      if (exitCheck.shouldExit) {
        stateMachine.transitionTo(exitCheck.nextState);
        currentState = stateMachine.getCurrentState();
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
