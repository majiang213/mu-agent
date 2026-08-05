import { describe, it, expect } from 'vitest';
import { CompleteCapture, completeReminder } from '../../src/tool/complete.js';
import { State } from '../../src/core/types.js';

/**
 * CompleteCapture — the complete() exit protocol's one home (architecture
 * review 2026-08-05, candidate 1). The slot, tool, and predicates behind one
 * interface; runStep / runReasonAttempt no longer hand-roll closures.
 */
describe('CompleteCapture', () => {
  it('starts uncaptured; the wired tool captures args on execute', async () => {
    const cap = new CompleteCapture(State.ANSWER);
    expect(cap.captured()).toBe(false);
    expect(cap.peek()).toBeNull();

    await cap.tool.execute('id', { answer: 'hello' });
    expect(cap.captured()).toBe(true);
    expect(cap.peek()).toEqual({ answer: 'hello' });
  });

  it('reset() drops the capture for a fresh attempt (clarify / parse-repair)', async () => {
    const cap = new CompleteCapture(State.REASON);
    await cap.tool.execute('id', { steps: [], needsClarify: true, questions: ['q?'] });
    expect(cap.captured()).toBe(true);

    cap.reset();
    expect(cap.captured()).toBe(false);
    expect(cap.peek()).toBeNull();

    // A later capture works after reset.
    await cap.tool.execute('id', { steps: [], needsClarify: false });
    expect(cap.peek()).toEqual({ steps: [], needsClarify: false });
  });

  it('schema-invalid args do NOT capture (the tool reports the error instead)', async () => {
    const cap = new CompleteCapture(State.ANSWER);
    const r = await cap.tool.execute('id', {});
    const text = r.content.flatMap((c) => (c.type === 'text' && c.text ? [c.text] : [])).join('');
    expect(text).toContain('validation failed');
    expect(cap.captured()).toBe(false);
  });

  it('the tool is named complete and carries the state schema', () => {
    const cap = new CompleteCapture(State.MODIFY);
    expect(cap.tool.name).toBe('complete');
    expect(cap.tool.parameters).toBeDefined();
  });
});

describe('completeReminder', () => {
  it('names the state registry reminderFields', () => {
    const r = completeReminder(State.MODIFY);
    expect(r).toContain('[REMINDER]');
    expect(r).toContain('Required fields:');
  });

  it('falls back to a generic hint for states without reminderFields', () => {
    // REASON declares no reminderFields — the fallback text shows.
    expect(completeReminder(State.REASON)).toContain('see system prompt');
  });

  it('names steps for the PLAN state', () => {
    expect(completeReminder(State.PLAN)).toContain('steps');
  });
});
