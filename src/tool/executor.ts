import { createCodingTools } from '@earendil-works/pi-coding-agent';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';

export interface ToolExecutionResult {
  success: boolean;
  output: string;
  error?: string;
}

export class ToolExecutor {
  private tools: Map<string, AgentTool<any>>;

  constructor(availableTools?: AgentTool<any>[]) {
    const toolList = availableTools ?? createCodingTools(process.cwd());
    this.tools = new Map(toolList.map((t) => [t.name, t]));
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        success: false,
        output: '',
        error: `Tool not found: ${toolName}. Available: ${[...this.tools.keys()].join(', ')}`,
      };
    }

    try {
      const toolCallId = `${toolName}-${Date.now()}`;
      const result = await tool.execute(toolCallId, args as any);
      const output = result.content
        .filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text)
        .join('');
      return { success: true, output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: '', error: message };
    }
  }

  getAvailableTools(): string[] {
    return [...this.tools.keys()];
  }
}

export function createToolExecutor(availableTools?: AgentTool<any>[]): ToolExecutor {
  return new ToolExecutor(availableTools);
}
