import {
  Container,
  Input,
  matchesKey,
  ProcessTerminal,
  Spacer,
  TUI,
} from '@mariozechner/pi-tui';
import { ConfigManager } from '../config/manager.js';
import { TaskScheduler } from '../core/agent.js';
import { StateMachineAgent } from '../core/session.js';
import { MetricsCollector } from '../core/metrics.js';
import { DynamicBorder } from './components/dynamic-border.js';
import { HeaderComponent } from './components/header.js';
import { MessageLog } from './components/message-log.js';
import { StatusBar } from './components/status-bar.js';

export interface TuiAppOptions {
  model: string;
  provider: string;
  baseUrl: string;
}

export class TuiApp {
  private tui: TUI;
  private header: HeaderComponent;
  private chatContainer: Container;
  private messageLog: MessageLog;
  private statusBar: StatusBar;
  private editorContainer: Container;
  private input: Input;
  private metrics: MetricsCollector;
  private history: string[] = [];
  private historyIndex = -1;
  private running = false;

  constructor(private options: TuiAppOptions) {
    const terminal = new ProcessTerminal();
    this.tui = new TUI(terminal);
    this.metrics = new MetricsCollector();

    this.header = new HeaderComponent({
      model: options.model,
      state: 'IDLE',
      taskIndex: 0,
      taskTotal: 0,
      contextPct: 0,
    });

    this.chatContainer = new Container();
    this.messageLog = new MessageLog();
    this.chatContainer.addChild(this.messageLog);

    this.statusBar = new StatusBar(this.tui);

    this.input = new Input();
    this.input.onSubmit = (value) => this.handleSubmit(value);
    this.input.onEscape = () => this.stop();

    this.editorContainer = new Container();
    this.editorContainer.addChild(new DynamicBorder());
    this.editorContainer.addChild(new Spacer(1));
    this.editorContainer.addChild(this.input);
    this.editorContainer.addChild(new Spacer(1));

    this.tui.addChild(this.header);
    this.tui.addChild(new DynamicBorder());
    this.tui.addChild(new Spacer(1));
    this.tui.addChild(this.chatContainer);
    this.tui.addChild(this.statusBar);
    this.tui.addChild(this.editorContainer);

    this.tui.addInputListener((data) => {
      if (matchesKey(data, 'ctrl+c') || data === 'q') {
        this.stop();
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+l')) {
        this.messageLog.clear();
        this.tui.requestRender(true);
        return { consume: true };
      }
      if (matchesKey(data, 'up') && this.history.length > 0) {
        this.historyIndex = Math.min(this.historyIndex + 1, this.history.length - 1);
        this.input.setValue(this.history[this.historyIndex] ?? '');
        this.tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, 'down')) {
        this.historyIndex = Math.max(this.historyIndex - 1, -1);
        this.input.setValue(this.historyIndex >= 0 ? (this.history[this.historyIndex] ?? '') : '');
        this.tui.requestRender();
        return { consume: true };
      }
      return undefined;
    });
  }

  start(): void {
    this.running = true;
    ConfigManager.getInstance().initialize();
    this.tui.setFocus(this.input);
    this.tui.start();
    this.messageLog.append('准备就绪，输入任务后按 Enter 执行', 'info');
    this.messageLog.append('快捷键: Ctrl+C 退出  Ctrl+L 清屏  ↑↓ 历史', 'info');
    this.tui.requestRender();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.statusBar.stop();
    this.tui.stop();
  }

  private async handleSubmit(value: string): Promise<void> {
    const task = value.trim();
    if (!task) return;

    this.input.setValue('');
    this.history.unshift(task);
    this.historyIndex = -1;

    this.messageLog.append(`📋 ${task}`, 'task');
    this.statusBar.start('分解任务...');
    this.header.update({ state: 'DECOMPOSE', taskIndex: 0, taskTotal: 0 });
    this.tui.requestRender();

    const scheduler = new TaskScheduler();
    const tasks = await scheduler.decompose(task);

    this.header.update({ taskTotal: tasks.length });
    this.messageLog.append(`分解为 ${tasks.length} 个子任务`, 'info');
    this.tui.requestRender();

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]!;
      this.header.update({ taskIndex: i + 1, state: 'ANALYZE' });
      this.messageLog.append(`子任务 ${i + 1}/${tasks.length}: ${t.description}`, 'task');
      this.statusBar.start(`执行中... [${i + 1}/${tasks.length}]`);
      this.tui.requestRender();

      this.metrics.startTask(t.id);
      this.metrics.recordStateEntry(t.id, 'ANALYZE');

      const agent = new StateMachineAgent(this.options.model);
      const onStateChange = (from: string, to: string) => {
        this.header.update({ state: to });
        this.messageLog.append(`[${to}]`, 'state');
        this.metrics.recordStateExit(t.id, from);
        this.metrics.recordStateEntry(t.id, to);
        this.tui.requestRender();
      };

      try {
        const result = await scheduler.executeTask(
          t,
          this.options.model,
          this.options.provider,
          this.options.baseUrl,
          (event) => {
            if (event.type === 'state_change') {
              onStateChange(event.from, event.to);
            } else if (event.type === 'tool_call') {
              this.messageLog.append(event.tool, 'tool');
              this.metrics.recordToolCall(t.id, event.tool);
            } else if (event.type === 'llm_call') {
              this.metrics.recordLLMCall(t.id, event.promptLen, event.responseLen);
              const summary = this.metrics.getSummary();
              const ctxPct = Math.min(100, Math.round((summary.avgTokens * (i + 1)) / 327.68));
              this.header.update({ contextPct: ctxPct });
            }
            this.tui.requestRender();
          },
        );

        this.metrics.recordStateExit(t.id, agent.getCurrentState());
        this.metrics.finishTask(t.id, result.success);

        if (result.success) {
          this.messageLog.append(`子任务 ${i + 1} 完成`, 'success');
        } else {
          this.messageLog.append(`子任务 ${i + 1} 失败`, 'error');
        }
      } catch (err) {
        this.metrics.finishTask(t.id, false);
        this.messageLog.append(`错误: ${String(err)}`, 'error');
      }

      this.tui.requestRender();
    }

    const summary = this.metrics.getSummary();
    this.statusBar.update('完成', summary);
    this.header.update({ state: 'DONE', taskIndex: tasks.length });
    this.messageLog.append(
      `全部完成  成功率 ${Math.round(summary.successRate * 100)}%  tokens≈${Math.round(summary.avgTokens * tasks.length)}`,
      'success',
    );
    this.statusBar.stop();
    this.header.update({ state: 'IDLE', taskIndex: 0, taskTotal: 0, contextPct: 0 });
    this.tui.requestRender();
  }
}

export function createTuiApp(options: TuiAppOptions): TuiApp {
  return new TuiApp(options);
}
