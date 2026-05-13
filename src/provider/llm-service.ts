import type { StateContext } from '../core/types.js';
import type { ToolCall } from '../core/types.js';
import { LLMConnector } from './llm.js';
import { buildSystemPrompt, buildUserPrompt } from '../core/prompts/index.js';

export class LLMService {
  private connector: LLMConnector;

  constructor(provider: string, modelName: string, baseUrl?: string) {
    this.connector = new LLMConnector(provider, modelName, baseUrl);
  }

  async generate(
    context: StateContext,
    task: string,
  ): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const systemPrompt = buildSystemPrompt({
      state: context.state,
      task,
      modelParams: { tier: 'SMALL', paramCount: 7, maxFilesPerTask: 2, maxRetries: 1, strictPlanning: true },
      context,
    });
    const userPrompt = buildUserPrompt(context.state, task);
    return this.connector.generate(systemPrompt, userPrompt);
  }
}
