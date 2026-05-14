import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import { streamSimple } from '@mariozechner/pi-ai';
import type { Model } from '@mariozechner/pi-ai';
import { codingTools } from '@mariozechner/pi-coding-agent';
import { StateMachineAgent } from './session.js';
import { State, type StateResult, type Step, type StepHandoff } from './types.js';
import { hasStateCompletionJson, advanceState } from './states.js';
import { buildSystemPrompt, buildUserPrompt } from './prompts/index.js';
import type { EnvContext } from './prompts/agent.js';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { StagnationDetector } from './cognitive/index.js';
import { FailureHandler } from './failure/handler.js';
import { LLMConnector } from '../provider/llm.js';
import { astLocatorTool } from '../tool/locator.js';
import { SafeModifier, syntaxCheckHook, damageCheckHook } from '../tool/safety/index.js';
import { ConfigManager } from '../config/manager.js';
import { CodeGraphLocator } from './graph/locator.js';

export type ExecutionEvent =
  | { type: 'state_change'; from: string; to: string }
  | { type: 'tool_call'; tool: string; args?: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; isError: boolean }
  | { type: 'llm_output'; content: string }
  | { type: 'llm_thinking'; content: string }
  | { type: 'llm_output_delta'; content: string }
  | { type: 'llm_thinking_delta'; content: string }
  | { type: 'llm_call'; promptLen: number; responseLen: number; contextTokens: number }
  | { type: 'llm_prompt'; systemPrompt: string; userPrompt: string }
  | { type: 'task_start'; taskIndex: number; taskTotal: number; description: string }
  | { type: 'task_done'; taskIndex: number; taskTotal: number }
  | { type: 'clarification_needed'; questions: string[] };

interface Mission {
  id: string;
  description: string;
  state: 'pending' | 'running' | 'completed' | 'failed';
  result?: StateResult;
}

interface RunConfig {
  model: Model<'openai-completions'>;
  stateMachine: StateMachineAgent;
  safetyConfig: ReturnType<ConfigManager['getConfig']>['safety'];
  smConfig: ReturnType<ConfigManager['getConfig']>['stateMachine'];
  failureConfig: ReturnType<ConfigManager['getConfig']>['failureHandling'];
  safeModifier: SafeModifier;
  env: EnvContext;
  temperature: number;
  projectRoot: string;
}

function buildModel(modelName: string, provider: string, baseUrl: string): Model<'openai-completions'> {
  const apiBase = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
  return {
    id: modelName,
    name: modelName,
    api: 'openai-completions',
    provider,
    baseUrl: apiBase,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
  };
}

function msgContent(msg: AgentMessage): string {
  if (!('content' in msg)) return '';
  const c = (msg as { content?: unknown }).content;
  return typeof c === 'string' ? c : JSON.stringify(c ?? '');
}

function compressConversationHistory(messages: AgentMessage[], tokenBudget = 6000): AgentMessage[] {
  if (messages.length === 0) return [];
  const anchor = messages[0]!;
  if (messages.length === 1) return [anchor];
  const recent: AgentMessage[] = [];
  let tokens = Math.ceil(msgContent(anchor).length / 4);
  for (let i = messages.length - 1; i > 0; i--) {
    const msg = messages[i]!;
    const t = Math.ceil(msgContent(msg).length / 4);
    if (tokens + t > tokenBudget) break;
    recent.unshift(msg);
    tokens += t;
  }
  return [anchor, ...recent];
}

function extractJsonFromText(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseReasonSteps(json: Record<string, unknown> | null): Step[] | null {
  if (!json || !Array.isArray(json['steps'])) return null;
  const validStates = new Set(Object.values(State));
  const steps = (json['steps'] as unknown[]).filter(
    (s): s is Step =>
      typeof s === 'object' &&
      s !== null &&
      typeof (s as Record<string, unknown>)['state'] === 'string' &&
      validStates.has((s as Record<string, unknown>)['state'] as State) &&
      typeof (s as Record<string, unknown>)['focus'] === 'string' &&
      ((s as Record<string, unknown>)['focus'] as string).length > 0,
  );
  return steps.length > 0 ? steps.slice(0, 6) : null;
}

function DEFAULT_FALLBACK_STEPS(description: string): Step[] {
  return [
    { state: State.LOCATE, focus: `Find the exact files and lines to change for: ${description}` },
    { state: State.MODIFY, focus: `Apply the necessary code changes for: ${description}` },
    { state: State.VERIFY, focus: `Verify the changes are correct for: ${description}` },
  ];
}

function buildStepAgent(
  systemPrompt: string,
  initialMessages: AgentMessage[],
  cfg: RunConfig,
  onEvent: ((event: ExecutionEvent) => void) | undefined,
  tools = [...codingTools, astLocatorTool],
): Agent {
  return new Agent({
    initialState: {
      systemPrompt,
      model: cfg.model,
      tools,
      ...(initialMessages.length > 0 ? { messages: initialMessages } : {}),
    },
    streamFn: async (m, agentCtx, opts) => {
      const lastUserMsg = [...agentCtx.messages].reverse().find((msg) => msg.role === 'user');
      const userPromptText =
        lastUserMsg && 'content' in lastUserMsg
          ? Array.isArray(lastUserMsg.content)
            ? (lastUserMsg.content as Array<{ type: string; text?: string }>)
                .filter((c) => c.type === 'text' && c.text)
                .map((c) => c.text as string)
                .join('\n')
            : typeof lastUserMsg.content === 'string'
              ? lastUserMsg.content
              : ''
          : '';
      onEvent?.({ type: 'llm_prompt', systemPrompt: agentCtx.systemPrompt ?? '', userPrompt: userPromptText });
      return streamSimple(m, agentCtx, { ...opts, apiKey: 'ollama', temperature: cfg.temperature });
    },
    getApiKey: () => 'ollama',
    beforeToolCall: async (toolCtx) => {
      const toolName = toolCtx.toolCall.name;
      if (toolName === 'edit' || toolName === 'write') {
        if (!cfg.stateMachine.canModifyMoreFiles(cfg.safetyConfig.maxFilesPerTask)) {
          return {
            block: true,
            reason: `File modification limit reached (max ${cfg.safetyConfig.maxFilesPerTask} files per task).`,
          };
        }
      }
      if ((toolName === 'edit' || toolName === 'write') && cfg.safetyConfig.enableCheckpoint) {
        const args = toolCtx.args as Record<string, unknown>;
        const filePath = typeof args['filePath'] === 'string' ? args['filePath'] : null;
        if (filePath) {
          try {
            await cfg.safeModifier.createCheckpoint(filePath);
          } catch (e) {
            void e;
          }
        }
      }
      return undefined;
    },
  });
}

function subscribeStepEvents(
  agent: Agent,
  state: State,
  stagnationDetector: StagnationDetector,
  cfg: RunConfig,
  onLlmText: (text: string) => void,
  onEvent?: (event: ExecutionEvent) => void,
): void {
  const pendingModifyPaths = new Map<string, string>();

  agent.subscribe((event: AgentEvent) => {
    if (event.type === 'tool_execution_start') {
      onEvent?.({ type: 'tool_call', tool: event.toolName, args: event.args as Record<string, unknown> });
      cfg.stateMachine.recordToolCall(event.toolName, event.args, null);
      stagnationDetector.recordToolCall({
        tool: event.toolName,
        input: event.args,
        output: null,
        timestamp: Date.now(),
      });
      if (event.toolName === 'edit' || event.toolName === 'write') {
        const args = event.args as Record<string, unknown>;
        const fp = typeof args['filePath'] === 'string' ? args['filePath'] : null;
        if (fp) pendingModifyPaths.set(event.toolCallId, fp);
      }
    }

    if (event.type === 'tool_execution_end') {
      onEvent?.({ type: 'tool_result', tool: event.toolName, isError: event.isError });
      const filePath = pendingModifyPaths.get(event.toolCallId);
      pendingModifyPaths.delete(event.toolCallId);
      if (event.isError) stagnationDetector.recordError(`tool_error:${event.toolName}`);
      if (
        filePath &&
        !event.isError &&
        cfg.safetyConfig.enableCheckpoint &&
        cfg.safetyConfig.enablePostCheck &&
        cfg.safeModifier.hasCheckpoint(filePath)
      ) {
        const checkpoint = cfg.safeModifier.getCheckpoint(filePath);
        const originalContent = checkpoint?.originalContent ?? '';
        Promise.all([
          syntaxCheckHook.check(filePath, originalContent),
          damageCheckHook.check(filePath, originalContent),
        ])
          .then(([syntaxOk, damageOk]) => {
            if (!syntaxOk || !damageOk) {
              stagnationDetector.recordError(`post_check_failed:${filePath}`);
              cfg.safeModifier
                .restore(filePath)
                .then(() => {
                  agent.steer({
                    role: 'user',
                    content: [
                      {
                        type: 'text',
                        text: `[SAFE MODIFIER] Post-check failed for ${filePath} (syntax=${syntaxOk}, damage=${damageOk}). File restored.`,
                      },
                    ],
                    timestamp: Date.now(),
                  });
                })
                .catch(() => {});
            } else {
              cfg.safeModifier.clearCheckpoint(filePath);
            }
          })
          .catch(() => {});
      }
    }

    if (event.type === 'message_update') {
      const ae = (event as any).assistantMessageEvent as { type: string };
      const msg = (event as any).message as { content?: Array<{ type: string; text?: string; thinking?: string }> };
      if (msg?.content) {
        const parts = msg.content;
        if (ae.type === 'thinking_delta' || ae.type === 'thinking_start') {
          const thinking = parts
            .filter((c) => c.type === 'thinking' && c.thinking)
            .map((c) => c.thinking as string)
            .join('');
          if (thinking) onEvent?.({ type: 'llm_thinking_delta', content: thinking });
        }
        if (ae.type === 'text_delta' || ae.type === 'text_start') {
          const text = parts
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text as string)
            .join('');
          if (text) onEvent?.({ type: 'llm_output_delta', content: text });
        }
      }
    }

    if (event.type === 'turn_end') {
      const msg = event.message;
      if (msg && 'content' in msg && Array.isArray(msg.content)) {
        const parts = msg.content as Array<{ type: string; text?: string; thinking?: string }>;
        const thinking = parts.filter((c) => c.type === 'thinking' && c.thinking).map((c) => c.thinking as string);
        const text = parts.filter((c) => c.type === 'text' && c.text).map((c) => c.text as string);
        if (thinking.length > 0) onEvent?.({ type: 'llm_thinking', content: thinking.join('\n') });
        if (text.length > 0) {
          const joined = text.join('\n');
          onEvent?.({ type: 'llm_output', content: joined });
          onLlmText(joined);
        }
      }
      const usage = msg && 'usage' in msg ? (msg as { usage?: { input?: number; output?: number } }).usage : null;
      const inputTokens = usage?.input ?? 0;
      onEvent?.({
        type: 'llm_call',
        promptLen: inputTokens,
        responseLen: usage?.output ?? 0,
        contextTokens: inputTokens,
      });

      const READ_ONLY_STATES = new Set([
        State.REASON,
        State.RESEARCH,
        State.ANSWER,
        State.REVIEW,
        State.DIAGNOSE,
        State.REFACTOR_PLAN,
      ]);
      if (cfg.smConfig.enableStagnationDetector && !READ_ONLY_STATES.has(state)) {
        const stagnationResult = stagnationDetector.check();
        if (stagnationResult?.detected) {
          agent.steer({
            role: 'user',
            content: [
              {
                type: 'text',
                text: `[STAGNATION DETECTED] ${stagnationResult.message}. ${stagnationResult.suggestion}.`,
              },
            ],
            timestamp: Date.now(),
          });
        }
      }
    }
  });
}

async function runStepAgent(
  agent: Agent,
  input: string,
  cfg: RunConfig,
  stagnationDetector: StagnationDetector,
): Promise<Error | null> {
  const maxRetries = Math.max(cfg.stateMachine.getModelParams().maxRetries, cfg.failureConfig.maxRetries);
  const failureHandler = new FailureHandler({
    maxRetries,
    onHumanIntervention: cfg.failureConfig.enableHumanIntervention
      ? (fCtx) => {
          console.error(`[HUMAN INTERVENTION REQUIRED] ${fCtx.error.message}`);
        }
      : undefined,
  });
  let attempt = 0;
  let lastError: Error | null = null;
  while (attempt < maxRetries) {
    try {
      await agent.prompt(input);
      lastError = null;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const failureCtx = failureHandler.createContext(
        'llm_error',
        lastError,
        cfg.stateMachine.getCurrentState(),
        attempt,
        {},
      );
      const recovery = await failureHandler.handleFailure(failureCtx);
      if (recovery.action === 'abort') break;
      cfg.temperature = Math.min(
        LLMConnector.DEFAULT_TEMPERATURE + attempt * LLMConnector.RETRY_TEMPERATURE_STEP,
        LLMConnector.MAX_TEMPERATURE,
      );
      stagnationDetector.reset();
      cfg.stateMachine.resetForRetry();
      cfg.safeModifier.clearAll();
    }
    attempt++;
  }
  return lastError;
}

async function runReasonStep(
  mission: Mission,
  cfg: RunConfig,
  conversationHistory: AgentMessage[],
  onEvent?: (event: ExecutionEvent) => void,
): Promise<{ steps: Step[]; needsClarify: boolean; questions: string[] }> {
  cfg.stateMachine.transitionTo(State.REASON);
  const systemPrompt = buildSystemPrompt({
    state: State.REASON,
    task: mission.description,
    modelParams: cfg.stateMachine.getModelParams(),
    env: cfg.env,
  });

  const stagnationDetector = new StagnationDetector();
  let llmText = '';
  const agent = buildStepAgent(systemPrompt, conversationHistory, cfg, onEvent, []);
  subscribeStepEvents(
    agent,
    State.REASON,
    stagnationDetector,
    cfg,
    (text) => {
      llmText = text;
    },
    onEvent,
  );

  onEvent?.({ type: 'state_change', from: 'IDLE', to: State.REASON });
  await runStepAgent(agent, mission.description, cfg, stagnationDetector);

  const json = extractJsonFromText(llmText);
  if (json?.['needsClarify'] === true) {
    const questions = Array.isArray(json['questions']) ? (json['questions'] as string[]) : [];
    return { steps: [], needsClarify: true, questions };
  }
  const parsedSteps = parseReasonSteps(json);
  const steps = parsedSteps ?? DEFAULT_FALLBACK_STEPS(mission.description);
  return { steps, needsClarify: false, questions: [] };
}

async function runStep(
  step: Step,
  stepIndex: number,
  stepTotal: number,
  mission: Mission,
  stepResults: StepHandoff[],
  cfg: RunConfig,
  onEvent?: (event: ExecutionEvent) => void,
): Promise<StepHandoff> {
  const trajectory = [step.state, State.DONE];
  cfg.stateMachine.resetForNextTask(step.state);

  const STATES_NEEDING_LOCATE = new Set([
    State.LOCATE,
    State.RESEARCH,
    State.DIAGNOSE,
    State.REVIEW,
    State.REFACTOR_PLAN,
  ]);

  let stepEnv = cfg.env;
  if (STATES_NEEDING_LOCATE.has(step.state)) {
    try {
      const locator = new CodeGraphLocator(cfg.projectRoot);
      const result = locator.locate(step.focus);
      stepEnv = {
        ...cfg.env,
        projectTree: result.tree,
        suggestedFiles: result.suggestedFiles,
      };
    } catch (e) {
      void e;
    }
  }

  const systemPrompt = buildSystemPrompt({
    state: step.state,
    task: mission.description,
    focus: step.focus,
    modelParams: cfg.stateMachine.getModelParams(),
    env: stepEnv,
  });

  const allowedTools = cfg.stateMachine.getAllowedTools();
  const stagnationDetector = new StagnationDetector();
  let llmText = '';

  const agent = buildStepAgent(systemPrompt, [], cfg, onEvent, allowedTools);

  subscribeStepEvents(
    agent,
    step.state,
    stagnationDetector,
    cfg,
    (text) => {
      llmText = text;
    },
    onEvent,
  );

  agent.subscribe((event: AgentEvent) => {
    if (event.type === 'turn_end') {
      const msg = event.message;
      const text =
        msg && 'content' in msg && Array.isArray(msg.content)
          ? (msg.content as Array<{ type: string; text?: string }>)
              .filter((c) => c.type === 'text' && c.text)
              .map((c) => c.text as string)
              .join('\n')
          : '';

      const isTextOnlyState = step.state === State.ANSWER || step.state === State.RESEARCH;
      const shouldAdvance = (isTextOnlyState && text.trim().length > 0) || hasStateCompletionJson(step.state, text);

      if (shouldAdvance) {
        const nextState = advanceState(step.state, trajectory);
        if (nextState !== step.state) {
          cfg.stateMachine.transitionTo(nextState);
          onEvent?.({ type: 'state_change', from: step.state, to: nextState });
        }
      }
    }
  });

  onEvent?.({ type: 'task_start', taskIndex: stepIndex, taskTotal: stepTotal, description: step.focus });
  onEvent?.({ type: 'state_change', from: State.REASON, to: step.state });

  const input = buildUserPrompt(step.state, mission.description, step.focus);
  await runStepAgent(agent, input, cfg, stagnationDetector);

  onEvent?.({ type: 'task_done', taskIndex: stepIndex, taskTotal: stepTotal });

  if (step.state === State.MODIFY) {
    try {
      const json = extractJsonFromText(llmText);
      const edited = Array.isArray(json?.['edited']) ? (json['edited'] as string[]) : [];
      if (edited.length > 0) {
        const locator = new CodeGraphLocator(cfg.projectRoot);
        const absPaths = edited.map((f) => (f.startsWith('/') ? f : `${cfg.projectRoot}/${f}`));
        locator.updateFiles(absPaths);
      }
    } catch (e) {
      void e;
    }
  }

  return { state: step.state, focus: step.focus, output: llmText };
}

export class ReactAgent {
  private _pendingClarification: ((answer: string) => void) | null = null;

  provideClarification(answer: string): void {
    if (this._pendingClarification) {
      this._pendingClarification(answer);
      this._pendingClarification = null;
    }
  }

  async run(
    input: string,
    modelName: string,
    provider: string,
    baseUrl: string,
    onEvent?: (event: ExecutionEvent) => void,
    initialMessages?: AgentMessage[],
  ): Promise<StateResult> {
    const mission: Mission = {
      id: `task-${Date.now()}`,
      description: input,
      state: 'running',
    };

    const stateMachine = new StateMachineAgent(modelName, [astLocatorTool]);
    const model = buildModel(modelName, provider, baseUrl);
    const agentConfig = ConfigManager.getInstance().getConfig();

    const cwd = process.cwd();
    const home = homedir();
    const cwdDisplay = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
    let isGitRepo: boolean;
    try {
      execSync('git rev-parse --git-dir', { stdio: 'ignore' });
      isGitRepo = true;
    } catch {
      isGitRepo = false;
    }

    const env: EnvContext = {
      cwd: cwdDisplay,
      platform: process.platform,
      isGitRepo,
      date: new Date().toDateString(),
    };

    const cfg: RunConfig = {
      model,
      stateMachine,
      safetyConfig: agentConfig.safety,
      smConfig: agentConfig.stateMachine,
      failureConfig: agentConfig.failureHandling,
      safeModifier: new SafeModifier(agentConfig.system.task.checkpointDir),
      env,
      temperature: LLMConnector.DEFAULT_TEMPERATURE,
      projectRoot: cwd,
    };

    const conversationHistory = compressConversationHistory(initialMessages ?? []);

    const { steps, needsClarify, questions } = await runReasonStep(mission, cfg, conversationHistory, onEvent);

    if (needsClarify) {
      onEvent?.({ type: 'clarification_needed', questions });
      return {
        state: State.DONE,
        success: true,
        output: 'Clarification needed',
        toolCalls: [],
        nextState: State.DONE,
        messages: [],
      };
    }

    const stepResults: StepHandoff[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const handoff = await runStep(step, i, steps.length, mission, stepResults, cfg, onEvent);
      stepResults.push(handoff);
    }

    onEvent?.({ type: 'state_change', from: steps[steps.length - 1]?.state ?? State.REASON, to: State.DONE });

    mission.state = 'completed';
    return {
      state: State.DONE,
      success: true,
      output: stepResults[stepResults.length - 1]?.output ?? 'Task completed',
      toolCalls: [],
      nextState: State.DONE,
      messages: [],
    };
  }
}
