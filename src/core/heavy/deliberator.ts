import { completeSimple } from '@mariozechner/pi-ai';
import type { RunConfig, ExecutionEvent, Mission } from '../agent/types.js';
import type { PlanCandidate, DeliberationResult, DeliberateOutcome } from './types.js';

const DELIBERATION_SYSTEM_BASE = `You are reviewing multiple execution plans for the same coding task.
Each plan was generated independently. Your job:
1. Compare the plans — what are the key differences?
2. Identify which plan is most likely to succeed and why.
3. If one plan clearly covers edge cases others miss, prefer it.
4. If plans are equivalent, prefer the simpler one (fewer steps).
5. If ALL plans share a potentially wrong assumption and critical information is missing,
   output needs_clarification (use ONLY when truly necessary, at most once per task).
6. If you genuinely cannot decide between two or more equally valid but different plans,
   output needs_plan_selection so the user can choose.

Return your decision in EXACTLY one of these formats (no extra text):

Option A — select a plan:
selected_plan_id: <id>
reason: <one sentence>
rejected: <id>: <why>

Option B — ask for clarification (critical info missing, at most once per task):
needs_clarification: true
question: <one specific question for the user>

Option C — let user choose (plans are equally valid but genuinely different approaches):
needs_plan_selection: true`;

function buildDeliberationSystem(candidates: PlanCandidate[]): string {
  const summaryLines = candidates
    .map((c) => `summary_${c.id}: <one sentence describing this plan's approach>`)
    .join('\n');
  return `${DELIBERATION_SYSTEM_BASE}\n${summaryLines}`;
}

export async function deliberate(
  candidates: PlanCandidate[],
  mission: Mission,
  cfg: RunConfig,
  onEvent?: (event: ExecutionEvent) => void,
  allowClarification = true,
): Promise<DeliberateOutcome> {
  if (candidates.length === 1) {
    return {
      type: 'selected',
      result: {
        selectedPlan: candidates[0]!,
        deliberationSummary: 'Single candidate',
        rejectedPlans: [],
      },
    };
  }

  if (allPlansSimilar(candidates)) {
    onEvent?.({ type: 'deliberation_fallback', reason: 'all plans similar, skipping deliberation' });
    return {
      type: 'selected',
      result: {
        selectedPlan: pickShortest(candidates),
        deliberationSummary: 'Plans too similar',
        rejectedPlans: [],
      },
    };
  }

  const candidatesText = candidates
    .map((c) => `Plan ${c.id}:\n${c.steps.map((s, i) => `  Step ${i + 1}: [${s.state}] ${s.focus}`).join('\n')}`)
    .join('\n\n');

  const systemPrompt = buildDeliberationSystem(candidates);
  const userPrompt = `Task: ${mission.description}\n\n${candidatesText}`;

  let raw: string;
  try {
    const result = await completeSimple(
      cfg.model,
      {
        systemPrompt,
        messages: [{ role: 'user', content: userPrompt, timestamp: Date.now() }],
      },
      {
        temperature: cfg.temperature,
        apiKey: cfg.apiKey,
      },
    );
    raw = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('');
  } catch {
    onEvent?.({ type: 'deliberation_fallback', reason: 'LLM call failed' });
    return {
      type: 'selected',
      result: {
        selectedPlan: pickShortest(candidates),
        deliberationSummary: 'Deliberation failed',
        rejectedPlans: [],
      },
    };
  }

  return parseDeliberationResponse(raw, candidates, onEvent, allowClarification);
}

function parseDeliberationResponse(
  raw: string,
  candidates: PlanCandidate[],
  onEvent?: (event: ExecutionEvent) => void,
  allowClarification = true,
): DeliberateOutcome {
  if (/needs_clarification:\s*true/i.test(raw)) {
    if (!allowClarification) {
      const summaries = candidates.map((c) => c.steps.map((s) => `[${s.state}] ${s.focus}`).join(' → '));
      return { type: 'needs_plan_selection', candidates, summaries };
    }
    const qMatch = raw.match(/question:\s*(.+)/);
    const question = qMatch?.[1]?.trim() ?? 'Can you provide more details about the task?';
    return { type: 'needs_clarification', question };
  }

  if (/needs_plan_selection:\s*true/i.test(raw)) {
    const summaries = candidates.map((c) => {
      const m = raw.match(new RegExp(`summary_${c.id}:\\s*(.+)`));
      return m?.[1]?.trim() ?? c.steps.map((s) => `[${s.state}] ${s.focus}`).join(' → ');
    });
    return { type: 'needs_plan_selection', candidates, summaries };
  }

  const idSet = new Set(candidates.map((c) => c.id));

  const match = raw.match(/selected_plan_id:\s*(\S+)/);
  if (match && idSet.has(match[1]!)) {
    return { type: 'selected', result: buildResult(match[1]!, raw, candidates) };
  }

  for (const id of idSet) {
    if (raw.includes(id)) {
      onEvent?.({ type: 'deliberation_fallback', reason: 'non-standard format, id scanned from text' });
      return { type: 'selected', result: buildResult(id, raw, candidates) };
    }
  }

  onEvent?.({ type: 'deliberation_fallback', reason: 'parse failed, presenting plans to user' });
  const summaries = candidates.map((c) => c.steps.map((s) => `[${s.state}] ${s.focus}`).join(' → '));
  return { type: 'needs_plan_selection', candidates, summaries };
}

function buildResult(selectedId: string, raw: string, candidates: PlanCandidate[]): DeliberationResult {
  const selected = candidates.find((c) => c.id === selectedId)!;
  const rejected = candidates
    .filter((c) => c.id !== selectedId)
    .map((plan) => {
      const m = raw.match(new RegExp(`${plan.id}:\\s*([^,\\n]+)`));
      return { plan, reason: m?.[1]?.trim() ?? 'not selected' };
    });
  return { selectedPlan: selected, deliberationSummary: raw, rejectedPlans: rejected };
}

function jaccard(a: PlanCandidate, b: PlanCandidate): number {
  const setA = new Set(a.steps.map((s) => `${s.state}:${s.focus}`));
  const setB = new Set(b.steps.map((s) => `${s.state}:${s.focus}`));
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 1 : intersection / union;
}

function allPlansSimilar(candidates: PlanCandidate[], threshold = 0.8): boolean {
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (jaccard(candidates[i]!, candidates[j]!) < threshold) return false;
    }
  }
  return true;
}

export function pickShortest(candidates: PlanCandidate[]): PlanCandidate {
  return candidates.reduce((a, b) => (a.steps.length <= b.steps.length ? a : b));
}
