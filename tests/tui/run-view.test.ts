import { describe, it, expect, vi } from 'vitest';
import type { Component, Loader } from '@earendil-works/pi-tui';

import { RunView } from '../../src/tui/run-view.js';
import type { RunViewHost } from '../../src/tui/run-view.js';
import { AssistantTurn, HeaderLine, SamplingBlock, SampleTurn, ToolExecutionBlock } from '../../src/tui/blocks.js';
import { MetricsCollector } from '../../src/tui/metrics.js';
import { State } from '../../src/core/types.js';

/**
 * Behavioral tests for the per-run view-model — the regex source-greps that
 * used to pin bugs 11/23/24/19a against app.ts are dead; the RunViewHost
 * seam lets a recording fake drive the real ExecutionEvent union headlessly.
 */

function makeHarness(options: { debugMode?: boolean } = {}) {
  const insertedLoader: Component[] = [];
  const insertedEditor: Component[] = [];
  const removed: Component[] = [];
  const host: RunViewHost = {
    insertBeforeLoader: (c) => {
      insertedLoader.push(c);
    },
    insertBeforeEditor: (c) => {
      insertedEditor.push(c);
    },
    removeComponent: (c) => {
      removed.push(c);
    },
    requestRender: () => {},
  };
  const loader = { setMessage: vi.fn() } as unknown as Loader;
  const header = new HeaderLine('test-model', '~/proj', 'main');
  const metrics = new MetricsCollector();
  metrics.startTask('t1');
  const onClarification = vi.fn();
  const runView = new RunView({
    host,
    header,
    loader,
    metrics,
    taskId: 't1',
    isDebugMode: () => options.debugMode ?? false,
    onClarification,
  });
  return { runView, insertedLoader, insertedEditor, removed, onClarification };
}

describe('Bug 11: tool_execution_end matches by toolId, not tool name', () => {
  it('resolves the correct block when two parallel calls share a tool name', () => {
    const { runView } = makeHarness();
    runView.handleEvent({ type: 'tool_execution_start', tool: 'read', toolId: 'id-1', args: {} });
    runView.handleEvent({ type: 'tool_execution_start', tool: 'read', toolId: 'id-2', args: {} });
    runView.handleEvent({ type: 'tool_execution_end', tool: 'read', toolId: 'id-2', isError: false, output: 'two' });

    const [first, second] = runView.toolBlocks;
    expect(first?.status).toBe('pending');
    expect(second?.status).toBe('ok');
  });
});

describe('Bug 23: sampling block is removed when the run ends', () => {
  it('dispose() removes the sampling block through the host', () => {
    const { runView, insertedLoader, removed } = makeHarness();
    runView.handleEvent({ type: 'deliberation_start', candidateCount: 3 });
    const sampling = insertedLoader.find((c) => c instanceof SamplingBlock);
    expect(sampling).toBeDefined();

    runView.dispose();
    expect(removed).toContain(sampling);
  });
});

describe('Bug 24: state_change → DONE clears the current turn', () => {
  it('a message after DONE starts a fresh AssistantTurn instead of appending to the stale one', () => {
    const { runView, insertedLoader } = makeHarness();
    runView.handleEvent({ type: 'message_update', content: 'first' });
    runView.handleEvent({ type: 'state_change', from: State.REASON, to: State.DONE });
    runView.handleEvent({ type: 'message_update', content: 'second' });

    const turns = insertedLoader.filter((c) => c instanceof AssistantTurn);
    expect(turns).toHaveLength(2);
  });
});

describe('Bug 19a: DebugBlock is only allocated in debug mode', () => {
  it('debug off → no debug blocks; debug on → one per state (deduped)', () => {
    const off = makeHarness({ debugMode: false });
    off.runView.handleEvent({ type: 'turn_start', systemPrompt: 's', userPrompt: 'u' });
    expect(off.runView.debugBlocks).toHaveLength(0);

    const on = makeHarness({ debugMode: true });
    on.runView.handleEvent({ type: 'turn_start', systemPrompt: 's', userPrompt: 'u' });
    on.runView.handleEvent({ type: 'turn_start', systemPrompt: 's2', userPrompt: 'u2' });
    expect(on.runView.debugBlocks).toHaveLength(1);
  });
});

describe('clarification events', () => {
  it('clarification_needed notifies the host and unlocks via callback', () => {
    const { runView, insertedEditor, onClarification } = makeHarness();
    runView.handleEvent({ type: 'clarification_needed', questions: ['q1', 'q2'] });
    expect(insertedEditor).toHaveLength(1);
    expect(onClarification).toHaveBeenCalledTimes(1);
  });

  it('deliberation_clarification appends to the sampling block and unlocks', () => {
    const { runView, onClarification } = makeHarness();
    runView.handleEvent({ type: 'deliberation_start', candidateCount: 2 });
    runView.handleEvent({ type: 'deliberation_clarification', question: 'which file?' });
    expect(onClarification).toHaveBeenCalledTimes(1);
  });
});

describe('rollback_performed', () => {
  it('renders a completed rollback block before the loader', () => {
    const { runView, insertedLoader } = makeHarness();
    runView.handleEvent({ type: 'rollback_performed', files: ['a.ts', 'b.ts'] });
    const block = insertedLoader.find((c) => c instanceof ToolExecutionBlock);
    expect(block).toBeDefined();
    expect((block as ToolExecutionBlock).status).toBe('ok');
  });
});

describe('sampling_stopped labels', () => {
  it('every reason variant is labeled without throwing', () => {
    const { runView } = makeHarness();
    runView.handleEvent({ type: 'deliberation_start', candidateCount: 2 });
    for (const reason of ['converged', 'max_count', 'max_rounds', 'no_new_info'] as const) {
      runView.handleEvent({ type: 'sampling_stopped', reason });
    }
  });
});

describe('round-5 candidate 8: tree glyph is render-time knowledge', () => {
  it('SamplingBlock computes ├/└ from child positions — no double └ after expansion', () => {
    const block = new SamplingBlock();
    block.addSample(new SampleTurn(0));
    block.addSample(new SampleTurn(1));
    // Expansion round adds a third turn: glyph of plan 2 must be ├, not └
    // (a stored per-batch total used to render both plan 2 and plan 3 as └).
    block.addSample(new SampleTurn(2));
    const text = block.render(80).join('\n');
    expect(text).toContain('├ plan 1');
    expect(text).toContain('├ plan 2');
    expect(text).not.toContain('└ plan 2');
    expect(text).toContain('└ plan 3');
  });
});

describe('round-5 candidate 4: toggle policy lives in RunView', () => {
  it('toggleTools expands all, then collapses all; returns false with no blocks', () => {
    const { runView } = makeHarness();
    expect(runView.toggleTools()).toBe(false);

    runView.handleEvent({ type: 'tool_execution_start', tool: 'read', toolId: 'id-1', args: {} });
    runView.handleEvent({ type: 'tool_execution_start', tool: 'bash', toolId: 'id-2', args: {} });
    expect(runView.toolBlocks.every((b) => !b.expanded)).toBe(true);

    expect(runView.toggleTools()).toBe(true);
    expect(runView.toolBlocks.every((b) => b.expanded)).toBe(true);

    expect(runView.toggleTools()).toBe(true);
    expect(runView.toolBlocks.every((b) => !b.expanded)).toBe(true);
  });

  it('toggleThinking covers sample turns', () => {
    const { runView } = makeHarness();
    runView.handleEvent({ type: 'deliberation_start', candidateCount: 2 });
    runView.handleEvent({ type: 'sample_start', index: 0 });
    runView.handleEvent({ type: 'sample_start', index: 1 });
    expect(runView.sampleTurns.length).toBe(2);

    expect(runView.toggleThinking()).toBe(true);
    expect(runView.sampleTurns.every((t) => t.expanded)).toBe(true);

    expect(runView.toggleThinking()).toBe(true);
    expect(runView.sampleTurns.every((t) => !t.expanded)).toBe(true);
  });

  it('setDebugVisible syncs debug block visibility and expansion', () => {
    const { runView } = makeHarness({ debugMode: true });
    runView.handleEvent({ type: 'turn_start', systemPrompt: 'sys', userPrompt: 'user' });
    expect(runView.debugBlocks.length).toBeGreaterThan(0);

    runView.setDebugVisible(false);
    for (const b of runView.debugBlocks) {
      expect(b.expanded).toBe(false);
    }

    runView.setDebugVisible(true);
    for (const b of runView.debugBlocks) {
      expect(b.expanded).toBe(true);
    }
  });
});
