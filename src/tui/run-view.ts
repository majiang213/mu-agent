import { Text } from '@earendil-works/pi-tui';
import type { Component, Loader } from '@earendil-works/pi-tui';

import type { ExecutionEvent } from '../core/agent/index.js';
import { C } from './theme.js';
import { AssistantTurn, DebugBlock, SampleTurn, SamplingBlock, ThinkingBlock, ToolExecutionBlock } from './blocks.js';
import type { HeaderLine } from './blocks.js';
import type { MetricsCollector } from './metrics.js';

/**
 * What RunView needs from the terminal — the SEAM (third-pass review,
 * candidate 9). TuiApp implements it over tui.children; tests implement it
 * with a recording fake and drive the whole ExecutionEvent union headlessly.
 */
export interface RunViewHost {
  /** Insert a component just before the run's loader (turns, sampling block). */
  insertBeforeLoader(component: Component): void;
  /** Insert a static component just before the editor (notices, warnings). */
  insertBeforeEditor(component: Component): void;
  /** Remove a previously inserted component (sampling block at dispose). */
  removeComponent(component: Component): void;
  requestRender(): void;
}

export interface RunViewDeps {
  host: RunViewHost;
  header: HeaderLine;
  loader: Loader;
  metrics: MetricsCollector;
  taskId: string;
  /** Read at turn_start so mid-run ctrl+d toggles take effect. */
  isDebugMode: () => boolean;
  /** clarification / deliberation_clarification → TuiApp unlocks the editor. */
  onClarification: () => void;
}

/**
 * Per-run view-model: owns the view state the ExecutionEvent stream drives
 * (current turn, sampling block, pending tools, per-state debug dedup,
 * expandable-block registries for the ctrl+t/ctrl+o/ctrl+d toggles). All
 * child-list surgery goes through RunViewHost — no terminal types leak in
 * beyond the Loader and HeaderLine it was handed.
 */
export class RunView {
  readonly thinkingBlocks: ThinkingBlock[] = [];
  readonly debugBlocks: DebugBlock[] = [];
  readonly sampleTurns: SampleTurn[] = [];
  readonly toolBlocks: ToolExecutionBlock[] = [];

  private currentTurn: AssistantTurn | null = null;
  private samplingBlock: SamplingBlock | null = null;
  private readonly pendingTools = new Set<string>();
  private readonly debugShownForState = new Set<string>();
  loaderState = 'REASON';

  constructor(private readonly deps: RunViewDeps) {}

  /**
   * ctrl+t toggle: expand every thinking/sample block, or collapse all when
   * any is expanded. The policy lives here (the view-model owns the block
   * registries) — the shell only binds keys (round-5, candidate 4).
   * Returns whether any block exists (false → shell skips the render).
   */
  toggleThinking(): boolean {
    const blocks = [...this.thinkingBlocks, ...this.sampleTurns];
    if (blocks.length === 0) return false;
    const anyExpanded = blocks.some((b) => b.expanded);
    for (const b of blocks) b.setExpanded(!anyExpanded);
    return true;
  }

  /** ctrl+o toggle: same algebra over tool blocks. */
  toggleTools(): boolean {
    if (this.toolBlocks.length === 0) return false;
    const anyExpanded = this.toolBlocks.some((b) => b.expanded);
    for (const b of this.toolBlocks) b.setExpanded(!anyExpanded);
    return true;
  }

  /** Extension ui.getToolsExpanded/setToolsExpanded (Gap 85-D). */
  get toolsExpanded(): boolean {
    return this.toolBlocks.some((b) => b.expanded);
  }

  setToolsExpanded(expanded: boolean): void {
    for (const b of this.toolBlocks) b.setExpanded(expanded);
  }

  /** ctrl+d: sync debug block visibility/expansion with the shell's debugMode. */
  setDebugVisible(visible: boolean): void {
    for (const b of this.debugBlocks) {
      b.setVisible(visible);
      b.setExpanded(visible);
    }
  }

  /** Detach run-scoped components from the terminal (end of run, abort, error). */
  dispose(): void {
    if (this.samplingBlock) {
      this.deps.host.removeComponent(this.samplingBlock);
      this.samplingBlock = null;
    }
  }

  private ensureCurrentTurn(state = 'REASON'): AssistantTurn {
    let turn = this.currentTurn;
    if (!turn) {
      turn = new AssistantTurn(state);
      this.deps.host.insertBeforeLoader(turn);
      this.currentTurn = turn;
    }
    return turn;
  }

  readonly handleEvent = (event: ExecutionEvent): void => {
    const { host, header, loader, metrics, taskId } = this.deps;

    if (event.type === 'state_change') {
      const prevState = this.loaderState;
      this.loaderState = event.to;
      header.setState(event.to);
      loader.setMessage(`[${event.to}]`);
      if (event.to !== 'DONE' && event.to !== 'SAMPLING' && event.to !== prevState) {
        const turn = new AssistantTurn(event.to);
        host.insertBeforeLoader(turn);
        this.currentTurn = turn;
      }
      if (event.to === 'DONE') {
        this.currentTurn = null;
      }
    } else if (event.type === 'turn_start') {
      const turn = this.ensureCurrentTurn();
      const alreadyShown = this.debugShownForState.has(this.loaderState);
      const debugMode = this.deps.isDebugMode() && !alreadyShown;
      const debugBlock = turn.startLlmTurn(event.systemPrompt, event.userPrompt, debugMode);
      if (debugBlock) {
        this.debugBlocks.push(debugBlock);
        this.debugShownForState.add(this.loaderState);
      }
    } else if (event.type === 'message_thinking_update') {
      const turn = this.ensureCurrentTurn();
      turn.updateThinking(event.content);
      if (turn.thinkingBlock && !this.thinkingBlocks.includes(turn.thinkingBlock)) {
        this.thinkingBlocks.push(turn.thinkingBlock);
      }
    } else if (event.type === 'message_update') {
      this.ensureCurrentTurn().updateOutput(event.content);
    } else if (event.type === 'message_thinking_end') {
      const turn = this.ensureCurrentTurn();
      turn.finalizeThinking(event.content);
      if (turn.thinkingBlock && !this.thinkingBlocks.includes(turn.thinkingBlock)) {
        this.thinkingBlocks.push(turn.thinkingBlock);
      }
    } else if (event.type === 'message_end') {
      this.ensureCurrentTurn().finalizeOutput(event.content);
    } else if (event.type === 'rollback_performed') {
      const block = new ToolExecutionBlock('rollback', { restored: event.files.join(', ') });
      block.setResult(false, event.files.join('\n'));
      host.insertBeforeLoader(block);
    } else if (event.type === 'tool_execution_start') {
      const turn = this.ensureCurrentTurn();
      this.pendingTools.add(event.toolId);
      const block = turn.addTool(event.toolId, event.tool, event.args);
      this.toolBlocks.push(block);
      loader.setMessage(`[${event.tool}]`);
    } else if (event.type === 'tool_execution_end') {
      const turn = this.currentTurn;
      if (turn && this.pendingTools.has(event.toolId)) {
        turn.resolveTool(event.toolId, event.isError, event.output);
        this.pendingTools.delete(event.toolId);
      }
    } else if (event.type === 'session_info') {
      header.setProviderInfo(event.provider, event.tier, event.contextWindow);
    } else if (event.type === 'turn_end') {
      metrics.recordLLMCall(taskId, event.promptLen, event.responseLen);
      header.updateTokenStats(event.promptLen, event.responseLen, event.contextTokens);
    } else if (event.type === 'task_start') {
      header.setState(event.description.slice(0, 20), event.taskIndex + 1, event.taskTotal);
    } else if (event.type === 'task_end') {
      void event;
    } else if (event.type === 'clarification_needed') {
      const questions = event.questions.map((q, i) => `  ${i + 1}. ${q}`).join('\n');
      host.insertBeforeEditor(new Text(C.dim('  Please confirm:\n') + questions, 0, 0));
      this.deps.onClarification();
    } else if (event.type === 'deliberation_start') {
      this.samplingBlock = new SamplingBlock();
      host.insertBeforeLoader(this.samplingBlock);
    } else if (event.type === 'sample_start') {
      if (this.samplingBlock) {
        const turn = new SampleTurn(event.index);
        this.samplingBlock.addSample(turn);
        this.sampleTurns.push(turn);
      }
    } else if (event.type === 'sample_thinking') {
      this.samplingBlock?.getSample(event.index)?.updateThinking(event.content);
    } else if (event.type === 'sample_complete') {
      this.samplingBlock?.getSample(event.index)?.complete(event.steps);
    } else if (event.type === 'sample_failed') {
      this.samplingBlock?.getSample(event.index)?.fail();
    } else if (event.type === 'sampling_progress') {
      void event;
    } else if (event.type === 'deliberation_refinement') {
      const label =
        event.verdict === 'converged'
          ? 'converged'
          : event.verdict === 'BETTER'
            ? 'better'
            : event.verdict === 'SAME'
              ? 'same'
              : 'worse';
      this.samplingBlock?.addLine(`  ↻ Refinement ${event.round}: ${label}`);
    } else if (event.type === 'deliberation_complete') {
      // Render the summary the deliberator computes (was a dead payload —
      // round-5 hygiene).
      this.samplingBlock?.addLine(`  ✓ ${event.summary}`);
    } else if (event.type === 'deliberation_fallback') {
      this.samplingBlock?.addLine(`  ⚠ ${event.reason}`);
    } else if (event.type === 'deliberation_clarification') {
      this.samplingBlock?.addLine(`  ? ${event.question}`);
      this.deps.onClarification();
    } else if (event.type === 'parallel_start') {
      header.setState(`⇉ parallel ${event.stepCount} steps`, undefined, undefined);
    } else if (event.type === 'parallel_complete') {
      void event;
    } else if (event.type === 'parallel_overlap') {
      host.insertBeforeEditor(
        new Text(
          `\n  ${C.err('⚠')} parallel branches edited the same file(s): ${event.files.join(', ')} — rollback may be unreliable for these\n`,
          0,
          0,
        ),
      );
    } else if (event.type === 'sampling_expand') {
      this.samplingBlock?.addLine(`  ↻ round ${event.round} divergence, expanding sampling`);
    } else if (event.type === 'subplan_start') {
      header.setState(`◎ ${event.analyzerState} (two-level planning)`, undefined, undefined);
    } else if (event.type === 'subplan_complete') {
      void event;
    } else if (event.type === 'plan_parse_error') {
      const errBlock = new ToolExecutionBlock('PLAN', { analyzerState: event.analyzerState });
      errBlock.setResult(true, event.output.slice(0, 300));
      host.insertBeforeEditor(errBlock);
    } else if (event.type === 'extension_notify') {
      const icon = event.level === 'error' ? C.err('✗') : event.level === 'warning' ? C.err('⚠') : C.dim('ℹ');
      host.insertBeforeEditor(new Text(`\n  ${icon} ${event.message}\n`, 0, 0));
    } else if (event.type === 'sampling_stopped') {
      const labels: Record<typeof event.reason, string> = {
        converged: 'converged',
        max_count: 'max count reached',
        max_rounds: 'max rounds reached',
        no_new_info: 'no new info',
      };
      this.samplingBlock?.addLine(`  ✓ sampling done (${labels[event.reason]})`);
    } else {
      // Exhaustiveness: adding an ExecutionEvent variant without handling it
      // here is a compile error (the leftover type is not assignable to never).
      const _exhaustive: never = event;
      void _exhaustive;
    }

    host.requestRender();
  };
}
