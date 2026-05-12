import { completeSimple } from '@mariozechner/pi-ai';
import type { Model, Context, AssistantMessage, TextContent } from '@mariozechner/pi-ai';
import type { ToolCall } from './state-machine/types.js';

export class LLMConnector {
  private model: Model<'openai-completions'>;

  constructor(provider: string, modelName: string, baseUrl?: string) {
    // Construct Model object directly for openai-completions compatible APIs (e.g. Ollama)
    const resolvedBaseUrl = baseUrl ?? 'http://localhost:11434';
    const apiBase = resolvedBaseUrl.endsWith('/v1')
      ? resolvedBaseUrl
      : `${resolvedBaseUrl}/v1`;

    this.model = {
      id: modelName,
      name: modelName,
      api: 'openai-completions',
      provider: provider,
      baseUrl: apiBase,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 4096,
    };
  }

  async generate(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<{ content: string; toolCalls: ToolCall[] }> {
    // system prompt goes in Context.systemPrompt, NOT as a message
    const context: Context = {
      systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt,
          timestamp: Date.now(),
        },
      ],
    };

    try {
      const response: AssistantMessage = await completeSimple(this.model, context, {
        temperature: 0.7,
        maxTokens: 2000,
      });

      return this.parseResponse(response);
    } catch (error) {
      console.error('LLM call failed:', error);
      throw error;
    }
  }

  private parseResponse(response: AssistantMessage): { content: string; toolCalls: ToolCall[] } {
    const toolCalls: ToolCall[] = [];
    let content = '';

    for (const item of response.content) {
      if (item.type === 'text') {
        content += (item as TextContent).text;
      } else if (item.type === 'toolCall') {
        // pi-ai ToolCall: { type, id, name, arguments }
        const tc = item as { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> };
        toolCalls.push({
          tool: tc.name,
          input: tc.arguments,
          output: null,
          timestamp: Date.now(),
        });
      }
    }

    return { content, toolCalls };
  }
}

/**
 * Create LLM connector
 */
export function createLLMConnector(
  provider: string,
  modelName: string,
  baseUrl?: string,
): LLMConnector {
  return new LLMConnector(provider, modelName, baseUrl);
}
