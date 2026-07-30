import { State } from '../types.js';
import type { Step, StepDirective } from '../types.js';

/**
 * The one home for StepDirective: parse / flatten / fingerprint / format.
 *
 * Previously these were implemented 2-5 times across step-runner.ts,
 * agent/index.ts, heavy/sampler.ts and heavy/deliberator.ts with divergent
 * rules (three fingerprint formats, two parsers). Any change to the
 * StepDirective grammar now lands here exactly once.
 */

const MAX_DIRECTIVES = 6;
const VALID_STATES = new Set<string>(Object.values(State));

function isValidStep(s: unknown, invalid: string[]): s is Step {
  if (typeof s !== 'object' || s === null) {
    invalid.push(String(s));
    return false;
  }
  const r = s as Record<string, unknown>;
  if (typeof r['state'] !== 'string' || !VALID_STATES.has(r['state'])) {
    invalid.push(`invalid state "${r['state']}"`);
    return false;
  }
  if (typeof r['focus'] !== 'string' || (r['focus'] as string).length === 0) {
    invalid.push(`missing focus for state "${r['state']}"`);
    return false;
  }
  return true;
}

function withWhy(step: Step, r: Record<string, unknown>): Step {
  if (typeof r['why'] === 'string' && r['why'].length > 0) step.why = r['why'];
  return step;
}

/**
 * Convert one raw entry into a directive, or null (+ an `invalid` note) when
 * it matches no valid shape. Parallel groups require >= 2 valid members
 * (the REASON completeSchema declares minItems: 2).
 */
function toDirective(item: unknown, invalid: string[]): StepDirective | null {
  if (typeof item !== 'object' || item === null) {
    invalid.push(String(item));
    return null;
  }
  const r = item as Record<string, unknown>;

  if (Array.isArray(r['parallel'])) {
    const members: Step[] = [];
    for (const ps of r['parallel'] as unknown[]) {
      if (isValidStep(ps, invalid)) {
        members.push(withWhy(ps, ps as unknown as Record<string, unknown>));
      }
    }
    return members.length >= 2 ? { parallel: members } : null;
  }

  if (typeof r['subplan'] === 'object' && r['subplan'] !== null) {
    const sp = r['subplan'] as Record<string, unknown>;
    // Gap 80: analyzerState MUST be PLAN — only the read-only sub-planner is
    // allowed. Any other state would bypass state guards.
    if (sp['analyzerState'] === State.PLAN && typeof sp['focus'] === 'string' && (sp['focus'] as string).length > 0) {
      return { subplan: { analyzerState: State.PLAN, focus: sp['focus'] as string } };
    }
    invalid.push('subplan must have analyzerState "PLAN" and a non-empty focus string');
    return null;
  }

  if (isValidStep(item, invalid)) {
    return withWhy(item, r);
  }
  return null;
}

/**
 * Parse REASON/PLAN complete() output into directives.
 * (Formerly parseReasonSteps in step-runner.ts.)
 */
export function parseDirectives(json: Record<string, unknown> | null): {
  steps: StepDirective[];
  error: string | null;
} {
  if (!json) return { steps: [], error: 'complete() was not called or returned no data.' };
  if (!Array.isArray(json['steps']))
    return { steps: [], error: 'steps must be an array. Got: ' + JSON.stringify(json['steps']) };

  const invalid: string[] = [];
  const directives: StepDirective[] = [];
  for (const item of json['steps'] as unknown[]) {
    const d = toDirective(item, invalid);
    if (d !== null) directives.push(d);
  }

  if (directives.length === 0 && invalid.length > 0) {
    return { steps: [], error: `Invalid entries: ${invalid.join(', ')}` };
  }
  // Cap at 6 directives (not flattened steps): a { parallel: [...] } counts as
  // one directive, so a parallel group may exceed 6 total steps.
  return { steps: directives.slice(0, MAX_DIRECTIVES), error: null };
}

/**
 * Parse deliberation LLM output: extract the first JSON array and parse it as
 * directives. Returns null when nothing valid is found.
 * (Formerly parseDirectivesJson in deliberator.ts.)
 */
export function parseDirectivesJson(raw: string): StepDirective[] | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return null;
    const invalid: string[] = [];
    const directives: StepDirective[] = [];
    for (const item of parsed) {
      const d = toDirective(item, invalid);
      if (d !== null) directives.push(d);
    }
    return directives.length > 0 ? directives.slice(0, MAX_DIRECTIVES) : null;
  } catch {
    return null;
  }
}

/**
 * Flatten directives into plain steps for signature/duplicate/match checks.
 * A subplan collapses to a single pseudo-step { state: PLAN, focus } (Gap 80).
 */
export function flattenDirectives(directives: StepDirective[]): Step[] {
  const out: Step[] = [];
  for (const d of directives) {
    if ('parallel' in d) {
      out.push(...d.parallel);
    } else if ('subplan' in d) {
      out.push({ state: State.PLAN, focus: d.subplan.focus });
    } else {
      out.push(d);
    }
  }
  return out;
}

/**
 * Canonical fingerprint of one directive: `STATE:focus`, with parallel
 * members sorted (order-independent) and a subplan keyed by its pseudo-step.
 * Used for dedup, Jaccard similarity, and retry-loop detection alike.
 */
export function directiveFingerprint(d: StepDirective): string {
  if ('parallel' in d) {
    return `P:${d.parallel
      .map((s) => `${s.state}:${s.focus}`)
      .sort()
      .join('|')}`;
  }
  if ('subplan' in d) {
    return `${State.PLAN}:${d.subplan.focus}`;
  }
  return `${d.state}:${d.focus}`;
}

/** Canonical fingerprint of a whole plan. */
export function planFingerprint(directives: StepDirective[]): string {
  return directives.map(directiveFingerprint).join('|');
}

/**
 * Compact one-token label for a directive — the TUI plan chain (`A → B →
 * P[X,Y] → PLAN`). The third copy of this mapping used to live inline in
 * SampleTurn; it belongs here beside the fingerprint it mirrors.
 */
export function directiveLabel(d: StepDirective): string {
  if ('parallel' in d) return `P[${d.parallel.map((s) => s.state).join(',')}]`;
  if ('subplan' in d) return State.PLAN;
  return d.state;
}

function formatStep(step: Step): string {
  const why = step.why ? `\n        why: ${step.why}` : '';
  return `  [${step.state}] ${step.focus}${why}`;
}

/** Human-readable one-entry-per-line format (deliberation cache / judge). */
export function formatDirective(d: StepDirective): string {
  if ('parallel' in d) {
    return `  [parallel]\n${d.parallel.map((s) => '    ' + formatStep(s).trimStart()).join('\n')}`;
  }
  if ('subplan' in d) {
    return `  [subplan → ${d.subplan.analyzerState}] ${d.subplan.focus}`;
  }
  return formatStep(d);
}
