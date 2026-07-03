import Database from 'better-sqlite3';
import type { Model } from '@earendil-works/pi-ai';
import { parseStructuredSummary } from './episode.js';

interface LLMSummary {
  description: string;
  keywords: string[];
}

async function generateEpisodeSummary(
  row: { episode_id: string; user_input: string; result_summary: string },
  model: Model<'openai-completions'>,
): Promise<LLMSummary> {
  const { completeSimple } = await import('@earendil-works/pi-ai');
  let context = row.user_input;
  const s = parseStructuredSummary(row.result_summary);
  if (s) {
    if (s.files?.length) context += `\n修改了: ${s.files.join(', ')}`;
    if (s.key_finding) context += `\n结论: ${s.key_finding}`;
    if (s.error_summary) context += `\n失败: ${s.error_summary}`;
  }

  const result = await completeSimple(
    model,
    {
      systemPrompt: `你是代码助手。用一句中文总结这次任务（≤50字），然后列出3-5个搜索关键词。\n输出格式（JSON）：{"description": "...", "keywords": ["...", "..."]}`,
      messages: [{ role: 'user', content: context, timestamp: Date.now() }],
    },
    { temperature: 0.1, apiKey: model.provider === 'ollama' ? 'ollama' : undefined },
  );

  try {
    const textContent = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('');
    const parsed = JSON.parse(textContent) as LLMSummary;
    return {
      description: (parsed.description ?? '').slice(0, 200),
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 10) : [],
    };
  } catch {
    return { description: row.user_input.slice(0, 100), keywords: [] };
  }
}

export async function processPendingSummaries(
  db: Database.Database,
  model: Model<'openai-completions'>,
  projectRoot: string,
): Promise<void> {
  const lastRun = db.prepare(`SELECT value FROM meta WHERE key = 'last_summary_at'`).get() as
    { value: string } | undefined;
  if (lastRun) {
    const elapsed = Math.floor(Date.now() / 1000) - parseInt(lastRun.value, 10);
    if (elapsed < 60) return;
  }

  const pending = db
    .prepare(
      `
    SELECT ps.episode_id, e.user_input, e.result_summary
    FROM pending_summaries ps
    JOIN episodes e ON e.id = ps.episode_id
    WHERE e.project_root = ?
    LIMIT 5
  `,
    )
    .all(projectRoot) as Array<{ episode_id: string; user_input: string; result_summary: string }>;

  if (pending.length === 0) {
    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('last_summary_at', ?)`).run(
      Math.floor(Date.now() / 1000).toString(),
    );
    return;
  }

  for (const row of pending) {
    try {
      const summary = await generateEpisodeSummary(row, model);
      const structuredSummary = parseStructuredSummary(row.result_summary);

      const txn = db.transaction(() => {
        db.prepare(
          `
          UPDATE episodes SET description = ?, keywords = ?, is_summarized = 1
          WHERE id = ?
        `,
        ).run(summary.description, JSON.stringify(summary.keywords), row.episode_id);

        const ep = db.prepare(`SELECT rowid, user_input FROM episodes WHERE id = ?`).get(row.episode_id) as
          { rowid: number; user_input: string } | undefined;
        if (ep) {
          const newContent = [
            ep.user_input,
            summary.description,
            summary.keywords.join(' '),
            structuredSummary?.key_finding ?? '',
            (structuredSummary?.files ?? []).join(' '),
          ].join(' ');
          db.prepare(`INSERT INTO episodes_fts(episodes_fts, rowid) VALUES('delete', ?)`).run(ep.rowid);
          db.prepare(`INSERT INTO episodes_fts(rowid, user_input, searchable_content) VALUES(?,?,?)`).run(
            ep.rowid,
            ep.user_input,
            newContent,
          );
        }

        db.prepare(`DELETE FROM pending_summaries WHERE episode_id = ?`).run(row.episode_id);
      });
      txn();
    } catch (err) {
      console.warn(
        '[summarizer] Failed to process episode',
        row.episode_id,
        ':',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('last_summary_at', ?)`).run(
    Math.floor(Date.now() / 1000).toString(),
  );
}
