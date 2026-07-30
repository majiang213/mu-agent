import { Type } from '@sinclair/typebox';
import type { MemoryStore } from '../core/memory/index.js';

/**
 * memory_search AgentTool (Gap 42). Goes through the MemoryStore interface —
 * no raw db handle, no imports of memory internals.
 */
export function createMemorySearchTool(store: MemoryStore) {
  return {
    name: 'memory_search',
    label: 'Memory Search',
    description:
      'Search past task history. Use query for keyword search, or id for exact lookup by short ID (e.g. "a3f2").',
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: 'Keyword search query' })),
      id: Type.Optional(Type.String({ description: 'Short episode ID (first 4 chars without dashes)' })),
    }),
    execute: async (
      _toolCallId: string,
      params: { query?: string; id?: string },
    ): Promise<{ content: [{ type: 'text'; text: string }]; details: { query?: string; id?: string } }> => {
      let text: string;
      if (params.id) {
        text = store.searchById(params.id) ?? `未找到 ID 为 #${params.id} 的记忆。`;
      } else if (params.query) {
        text = store.search(params.query);
      } else {
        text = '请提供 query 或 id 参数。';
      }
      return {
        content: [{ type: 'text' as const, text }],
        details: { query: params.query, id: params.id },
      };
    },
  };
}
