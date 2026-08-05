import type { Model, Models } from '@earendil-works/pi-ai';

/**
 * completeSimple + text-block extraction — one home (round-7, candidate 4).
 * The call sites (deliberation, refinement judge, episode summarizer) each
 * hand-rolled the same filter/join; only their parses genuinely differ and
 * stay site-local. Throws on LLM failure — each site keeps its own catch
 * policy (fallback event / SAME verdict / propagate).
 */
export async function completeText(
  models: Models,
  model: Model<'openai-completions'>,
  prompt: { systemPrompt: string; user: string },
  options: { temperature: number },
): Promise<string> {
  const result = await models.completeSimple(
    model,
    {
      systemPrompt: prompt.systemPrompt,
      messages: [{ role: 'user', content: prompt.user, timestamp: Date.now() }],
    },
    { temperature: options.temperature },
  );
  return result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('');
}
