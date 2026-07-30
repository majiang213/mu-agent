import { completeSimple } from '@earendil-works/pi-ai';
import type { Model } from '@earendil-works/pi-ai';
import type { RunConfig, ExecutionEvent, Mission } from '../agent/types.js';
import type { StepDirective } from '../types.js';
import type { PlanCandidate, DeliberateOutcome } from './types.js';
import { directiveFingerprint, formatDirective, parseDirectivesJson } from '../agent/directives.js';

const DELIBERATION_SYSTEM = `You are a coding task planner reviewing multiple independently generated execution plans for the same task.

Your job:
1. Critically evaluate each plan's reasoning (the "why" fields) — do not simply follow the majority.
2. Synthesize the strongest elements across all plans into a single final plan.
3. If all plans share a fundamental flaw, re-derive a better plan from scratch based on the task description.
4. Output only the final execution steps as a JSON array — no meta-analysis, no explanation.

Output format (JSON array only, nothing else):
[
  {"state": "LOCATE", "focus": "...", "why": "..."},
  {"state": "MODIFY", "focus": "..."},
  {"subplan": {"analyzerState": "PLAN", "focus": "analyze git changes, plan atomic commits"}},
  {"parallel": [{"state": "MODIFY", "focus": "fix a.js"}, {"state": "MODIFY", "focus": "fix b.js"}]}
]

Rules:
- Each entry is one of: a single step {state, focus, why?}, a subplan {subplan: {analyzerState, focus}}, or a parallel group {parallel: [...]}.
- "state" must be a valid state name; "focus" describes the action.
- "analyzerState" for subplan must be "PLAN".
- "why" is optional — include only when it adds real information.
- Maximum 6 entries.
- If the task is genuinely unclear and you cannot synthesize a plan, output exactly: needs_clarification: true
  followed by: question: <one specific question>`;

const JUDGE_SYSTEM = `You are evaluating two execution plans for the same coding task.
Reply with exactly one word: BETTER, WORSE, or SAME.
BETTER = new plan is more likely to succeed than current best.
WORSE = new plan is less likely to succeed than current best.
SAME = both plans are equivalent.
No explanation. One word only.`;

function buildMemoryCache(candidates: PlanCandidate[]): string {
  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return shuffled
    .map((c, i) => `--- Plan ${labels[i] ?? String(i + 1)} ---\n${c.steps.map(formatDirective).join('\n')}`)
    .join('\n\n');
}

function formatStepsForJudge(steps: StepDirective[]): string {
  return steps.map(formatDirective).join('\n');
}

function jaccardDirectives(a: StepDirective[], b: StepDirective[]): number {
  const setA = new Set(a.map(directiveFingerprint));
  const setB = new Set(b.map(directiveFingerprint));
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 1 : intersection / union;
}

async function runSingleDeliberation(
  memoryCache: string,
  mission: Mission,
  cfg: RunConfig,
  deliberationModel: Model<'openai-completions'>,
  allowClarification: boolean,
  onEvent?: (event: ExecutionEvent) => void,
): Promise<DeliberateOutcome | null> {
  const userPrompt = `Task: ${mission.description}\n\n${memoryCache}`;

  let raw: string;
  try {
    const result = await completeSimple(
      deliberationModel,
      { systemPrompt: DELIBERATION_SYSTEM, messages: [{ role: 'user', content: userPrompt, timestamp: Date.now() }] },
      { temperature: cfg.temperature, apiKey: cfg.apiKey },
    );
    raw = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('');
  } catch {
    onEvent?.({ type: 'deliberation_fallback', reason: 'LLM 调用失败' });
    return null;
  }

  if (/needs_clarification:\s*true/i.test(raw)) {
    if (allowClarification) {
      const qMatch = raw.match(/question:\s*(.+)/);
      const question = qMatch?.[1]?.trim() ?? 'Can you provide more details about the task?';
      return { type: 'needs_clarification', question };
    }
    onEvent?.({ type: 'deliberation_fallback', reason: '需要澄清，已跳过' });
    return null;
  }

  const steps = parseDirectivesJson(raw);
  if (steps && steps.length > 0) {
    return {
      type: 'selected',
      result: { synthesizedSteps: steps, deliberationSummary: raw.slice(0, 200) },
    };
  }

  onEvent?.({ type: 'deliberation_fallback', reason: '解析失败，响应中无有效 steps' });
  return null;
}

async function judgeRefinement(
  mission: Mission,
  bestSteps: StepDirective[],
  newSteps: StepDirective[],
  deliberationModel: Model<'openai-completions'>,
  apiKey: string,
): Promise<'BETTER' | 'WORSE' | 'SAME'> {
  const userPrompt = `Task: ${mission.description}

Current best plan:
${formatStepsForJudge(bestSteps)}

New plan:
${formatStepsForJudge(newSteps)}`;

  try {
    const result = await completeSimple(
      deliberationModel,
      { systemPrompt: JUDGE_SYSTEM, messages: [{ role: 'user', content: userPrompt, timestamp: Date.now() }] },
      { temperature: 0, apiKey },
    );
    const raw = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('')
      .trim()
      .toUpperCase();

    if (raw.startsWith('BETTER')) return 'BETTER';
    if (raw.startsWith('WORSE')) return 'WORSE';
    return 'SAME';
  } catch {
    return 'SAME';
  }
}

export async function deliberate(
  candidates: PlanCandidate[],
  mission: Mission,
  cfg: RunConfig,
  onEvent?: (event: ExecutionEvent) => void,
  allowClarification = true,
): Promise<DeliberateOutcome> {
  if (candidates.length === 0) {
    onEvent?.({ type: 'deliberation_fallback', reason: '无可用方案' });
    return { type: 'selected', result: { synthesizedSteps: [], deliberationSummary: 'no candidates' } };
  }

  if (candidates.length === 1) {
    return {
      type: 'selected',
      result: { synthesizedSteps: candidates[0]!.steps, deliberationSummary: 'single candidate' },
    };
  }

  if (allPlansSimilar(candidates)) {
    onEvent?.({ type: 'deliberation_fallback', reason: '所有方案相似，直接采用' });
    return {
      type: 'selected',
      result: { synthesizedSteps: pickShortest(candidates).steps, deliberationSummary: 'plans too similar' },
    };
  }

  const deliberationModel = cfg.heavyThinking?.deliberationModel
    ? { ...cfg.model, id: cfg.heavyThinking.deliberationModel, name: cfg.heavyThinking.deliberationModel }
    : cfg.model;

  let memoryCache = buildMemoryCache(candidates);

  const firstOutcome = await runSingleDeliberation(
    memoryCache,
    mission,
    cfg,
    deliberationModel,
    allowClarification,
    onEvent,
  );

  if (!firstOutcome) {
    return {
      type: 'selected',
      result: { synthesizedSteps: pickShortest(candidates).steps, deliberationSummary: 'deliberation failed' },
    };
  }

  if (firstOutcome.type === 'needs_clarification') return firstOutcome;

  let bestSteps = firstOutcome.result.synthesizedSteps;

  for (let iter = 0; iter < 8; iter++) {
    const round = iter + 1;
    memoryCache += `\n\n--- Deliberation result (round ${round}) ---\n${bestSteps.map(formatDirective).join('\n')}`;

    const nextOutcome = await runSingleDeliberation(memoryCache, mission, cfg, deliberationModel, false, onEvent);

    if (!nextOutcome || nextOutcome.type !== 'selected') break;

    const newSteps = nextOutcome.result.synthesizedSteps;

    const verdict = await judgeRefinement(mission, bestSteps, newSteps, deliberationModel, cfg.apiKey);

    if (verdict === 'WORSE' || verdict === 'SAME') {
      onEvent?.({ type: 'deliberation_refinement', round, verdict });
      break;
    }

    if (jaccardDirectives(newSteps, bestSteps) > 0.85) {
      onEvent?.({ type: 'deliberation_refinement', round, verdict: 'converged' });
      bestSteps = newSteps;
      break;
    }

    onEvent?.({ type: 'deliberation_refinement', round, verdict: 'BETTER' });
    bestSteps = newSteps;
  }

  return {
    type: 'selected',
    result: { synthesizedSteps: bestSteps, deliberationSummary: `synthesized from ${candidates.length} plans` },
  };
}

function allPlansSimilar(candidates: PlanCandidate[], threshold = 0.8): boolean {
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (jaccardDirectives(candidates[i]!.steps, candidates[j]!.steps) < threshold) return false;
    }
  }
  return true;
}

export function pickShortest(candidates: PlanCandidate[]): PlanCandidate {
  if (candidates.length === 0) return { id: 'empty', steps: [], sampledAt: Date.now() };
  return candidates.reduce((a, b) => (a.steps.length <= b.steps.length ? a : b));
}
