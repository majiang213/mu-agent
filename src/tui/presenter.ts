/**
 * RunPresenter — pure, terminal-free presentation logic for a finished run.
 *
 * Extracted from app.ts (architecture review 2026-07-30, candidate 4): the
 * result-schema interpretation and session-message shaping used to live
 * inline in the 1100-line TUI module, untestable without a terminal.
 * Everything here is a pure function and unit-tested headlessly.
 */

/** Legacy presentation prefix older sessions carry in persisted assistant
 *  messages. It used to be fed back into the model's context on --resume. */
export const LEGACY_ASSISTANT_PREFIX = '[Assistant]: ';

/**
 * Interpret a run's final output for display.
 *
 * The output is usually the ANSWER step's complete() JSON, but REASON may
 * have ended the plan early, so probe the known completeSchema field shapes
 * (answer / report / summary / edited+linesChanged / locations — see
 * STATE_REGISTRY). Returns '' when there is nothing worth displaying.
 */
export function formatRunResult(output: string | undefined): string {
  if (!output || output === 'Task completed') return '';
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(output) as Record<string, unknown>;
  } catch {
    return output;
  }

  const text =
    typeof parsed['answer'] === 'string'
      ? parsed['answer']
      : typeof parsed['report'] === 'string'
        ? parsed['report']
        : typeof parsed['summary'] === 'string'
          ? parsed['summary']
          : null;
  if (text) return text;

  if (Array.isArray(parsed['edited'])) {
    const files = (parsed['edited'] as string[]).join(', ');
    const lines = typeof parsed['linesChanged'] === 'number' ? `, ${parsed['linesChanged']} lines` : '';
    return `Edited: ${files}${lines}`;
  }

  if (Array.isArray(parsed['locations'])) {
    const locs = parsed['locations'] as Array<{ file: string; startLine?: number }>;
    return locs.map((l) => `${l.file}${l.startLine ? `:${l.startLine}` : ''}`).join(', ');
  }

  return '';
}

/** Shape an assistant message for session persistence (no presentation prefix). */
export function assistantMessageForSession(
  display: string,
  timestamp: number,
): { role: 'assistant'; content: string; timestamp: number } {
  return { role: 'assistant', content: display, timestamp };
}

/** Strip the legacy presentation prefix from a loaded assistant message. */
export function stripLegacyPrefix(content: string): string {
  return content.startsWith(LEGACY_ASSISTANT_PREFIX) ? content.slice(LEGACY_ASSISTANT_PREFIX.length) : content;
}

/**
 * Strip legacy prefixes from a loaded session history. Cast contained: legacy
 * sessions hold assistant messages with plain-string content, which the
 * current AgentMessage union models as block arrays — the boundary cast is
 * isolated here.
 */
export function stripLegacyPrefixes(
  messages: import('@earendil-works/pi-agent-core').AgentMessage[],
): import('@earendil-works/pi-agent-core').AgentMessage[] {
  return messages.map((m) => {
    const content = (m as { content?: unknown }).content;
    if (m.role === 'assistant' && typeof content === 'string') {
      return {
        ...(m as unknown as Record<string, unknown>),
        content: stripLegacyPrefix(content),
      } as unknown as import('@earendil-works/pi-agent-core').AgentMessage;
    }
    return m;
  });
}
