import type { StateContext } from '../state-machine/types.js';
import type { ToolCall } from '../state-machine/types.js';
import { LLMConnector } from '../llm-connector.js';
import { PromptBuilder } from './prompt-builder.js';

export class LLMService {
  private connector: LLMConnector;
  private promptBuilder: PromptBuilder;

  constructor(provider: string, modelName: string, baseUrl?: string) {
    this.connector = new LLMConnector(provider, modelName, baseUrl);
    this.promptBuilder = new PromptBuilder();
  }

  async generate(
    context: StateContext,
    task: string,
  ): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const systemPrompt = this.promptBuilder.buildSystemPrompt({
      state: context.state,
      task,
      modelParams: { tier: 'SMALL', paramCount: 7, maxFilesPerTask: 2, maxRetries: 1, strictPlanning: true },
      context,
    });
    const userPrompt = this.promptBuilder.buildUserPrompt(context.state, task);
    return this.connector.generate(systemPrompt, userPrompt);
  }
}
