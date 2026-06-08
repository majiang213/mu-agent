import { completeSimple } from '@earendil-works/pi-ai';
import type { Model } from '@earendil-works/pi-ai';
import type { RunConfig, ExecutionEvent, Mission } from '../agent/types.js';
import { State, type Step } from '../types.js';
import type { PlanCandidate, DeliberateOutcome } from './types.js';

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
  ...
]

Rules:
- Each step must have "state" (valid state name) and "focus" (what to do).
- "why" is optional — include only when it adds real information.
- Maximum 6 steps.
- If the task is genuinely unclear and you cannot synthesize a plan, output exactly: needs_clarification: true
  followed by: question: <one specific question>`;

const JUDGE_SYSTEM = `You are evaluating two execution plans for the same coding task.
Reply with exactly one word: BETTER, WORSE, or SAME.
BETTER = new plan is more likely to succeed than current best.
WORSE = new plan is less likely to succeed than current best.
SAME = both plans are equivalent.
No explanation. One word only.`;

function formatStepForCache(step: Step): string {
  const why = step.why ? `\n        why: ${step.why}` : '';
  return `  [${step.state}] ${step.focus}${why}`;
}

function buildMemoryCache(candidates: PlanCandidate[]): string {
  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return shuffled
    .map((c, i) => `--- Plan ${labels[i] ?? String(i + 1)} ---\n${c.steps.map(formatStepForCache).join('\n')}`)
    .join('\n\n');
}

function formatStepsForJudge(steps: Step[]): string {
  return steps.map(formatStepForCache).join('\n');
}

function jaccardSteps(a: Step[], b: Step[]): number {
  const setA = new Set(a.map((s) => `${s.state}:${s.focus}`));
  const setB = new Set(b.map((s) => `${s.state}:${s.focus}`));
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 1 : intersection / union;
}

function parseStepsJson(raw: string): Step[] | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  const validStates = new Set(Object.values(State));
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown[];
    if (!Array.isArray(parsed)) return null;
    const steps: Step[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const r = item as Record<string, unknown>;
      if (typeof r['state'] !== 'string' || !validStates.has(r['state'] as State)) continue;
      if (typeof r['focus'] !== 'string' || r['focus'].length === 0) continue;
      const step: Step = { state: r['state'] as Step['state'], focus: r['focus'] };
      if (typeof r['why'] === 'string' && r['why'].length > 0) step.why = r['why'];
      steps.push(step);
    }
    return steps.length > 0 ? steps.slice(0, 6) : null;
  } catch {
    return null;
  }
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

  const steps = parseStepsJson(raw);
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
  bestSteps: Step[],
  newSteps: Step[],
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
    memoryCache += `\n\n--- Deliberation result (round ${round}) ---\n${bestSteps.map(formatStepForCache).join('\n')}`;

    const nextOutcome = await runSingleDeliberation(memoryCache, mission, cfg, deliberationModel, false, onEvent);

    if (!nextOutcome || nextOutcome.type !== 'selected') break;

    const newSteps = nextOutcome.result.synthesizedSteps;

    const verdict = await judgeRefinement(mission, bestSteps, newSteps, deliberationModel, cfg.apiKey);

    if (verdict === 'WORSE' || verdict === 'SAME') {
      onEvent?.({ type: 'deliberation_refinement', round, verdict });
      break;
    }

    if (jaccardSteps(newSteps, bestSteps) > 0.85) {
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
      if (jaccardSteps(candidates[i]!.steps, candidates[j]!.steps) < threshold) return false;
    }
  }
  return true;
}

export function pickShortest(candidates: PlanCandidate[]): PlanCandidate {
  if (candidates.length === 0) return { id: 'empty', steps: [], sampledAt: Date.now() };
  return candidates.reduce((a, b) => (a.steps.length <= b.steps.length ? a : b));
}
