import Database from 'better-sqlite3';
import { Type } from '@sinclair/typebox';
import { graphRetrieve } from '../core/memory/retrieval.js';
import { formatEpisodeDetail } from '../core/memory/episode.js';
import type { EpisodeRow } from '../core/memory/types.js';

export function createMemorySearchTool(db: Database.Database, projectRoot: string) {
  return {
    name: 'memory_search',
    description:
      'Search past task history. Use query for keyword search, or id for exact lookup by short ID (e.g. "a3f2").',
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: 'Keyword search query' })),
      id: Type.Optional(Type.String({ description: 'Short episode ID (first 4 chars without dashes)' })),
    }),
    execute: async (params: { query?: string; id?: string }): Promise<string> => {
      if (params.id) {
        const row = db
          .prepare(
            `
          SELECT rowid, id, user_input, result_summary, timestamp, step_outputs,
            action_type, files_changed, success, is_summarized, description, keywords, tokens_used, project_root
          FROM episodes
          WHERE project_root = ? AND REPLACE(id, '-', '') LIKE ?
          LIMIT 1
        `,
          )
          .get(projectRoot, `${params.id}%`) as EpisodeRow | undefined;
        if (!row) return `未找到 ID 为 #${params.id} 的记忆。`;
        return formatEpisodeDetail(row);
      }

      if (params.query) {
        const rows = graphRetrieve(params.query, db, projectRoot);
        if (rows.length === 0) return `未找到与"${params.query}"相关的记忆。`;
        return rows.map((r) => formatEpisodeDetail(r)).join('\n\n---\n\n');
      }

      return '请提供 query 或 id 参数。';
    },
  };
}
