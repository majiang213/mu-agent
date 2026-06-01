import { basename } from 'node:path';
import type { ExecutedStep } from '../types.js';
import type { StructuredSummary, EntityNode } from './types.js';
import { State } from '../types.js';

export interface ActionWords {
  type: string | null;
  keywords: string[];
}

export function detectActionWords(userInput: string): ActionWords {
  const lower = userInput.toLowerCase();
  let type: string | null = null;
  if (/fix.*failed|修复失败/.test(lower)) type = 'fix_failed';
  else if (/修改|改|edit|fix|修复|bug/.test(lower)) type = 'edit';
  else if (/新建|创建|create|add.*file/.test(lower)) type = 'create';
  else if (/审查|review/.test(lower)) type = 'review';
  else if (/解释|explain|理解|搜索|查|诊断|debug|调查/.test(lower)) type = 'check';
  else if (/回答|answer/.test(lower)) type = 'answer';

  const keywords: string[] = [];
  const fileRegex = /[\w\-.]+\.(ts|js|tsx|jsx|py|java|go|rs|cpp|cs)\b/g;
  for (const m of userInput.matchAll(fileRegex)) keywords.push(m[0]);
  const words = lower.split(/\s+/).filter((w) => w.length > 2);
  keywords.push(...words.slice(0, 5));

  return { type, keywords: [...new Set(keywords)] };
}

export function extractEntitiesForQuery(userInput: string): string[] {
  const fileRegex = /[\w\-.]+\.(ts|js|tsx|jsx|py|java|go|rs|cpp|cs)\b/g;
  return [...userInput.matchAll(fileRegex)].map((m) => m[0]);
}

export function extractEntitiesForWrite(
  description: string,
  _steps: ExecutedStep[],
  summary: StructuredSummary,
): EntityNode[] {
  const results: EntityNode[] = [];

  for (const f of summary.files) {
    results.push({ type: 'file', name: basename(f), role: 'edited' });
  }

  const editedNames = new Set(summary.files.map((f) => basename(f)));
  for (const f of summary.locate_files) {
    if (!editedNames.has(basename(f))) {
      results.push({ type: 'file', name: basename(f), role: 'mentioned' });
    }
  }

  const errRegex = /\b\w*(?:Error|Exception|Panic)\b/g;
  for (const m of description.matchAll(errRegex)) {
    results.push({ type: 'error', name: m[0], role: 'caused' });
  }

  return results;
}

export function inferRunActionType(steps: ExecutedStep[], description: string): string {
  const states = steps.map((s) => s.state as string);
  const hasMODIFY = states.includes(State.MODIFY);
  const hasROLLBACK = states.includes(State.ROLLBACK);
  const hasANSWER = states.includes(State.ANSWER);
  const hasREVIEW = states.includes(State.REVIEW);
  const hasRESEARCH = states.includes(State.RESEARCH);
  const hasDIAGNOSE = states.includes(State.DIAGNOSE);

  if (hasROLLBACK) return 'fix_failed';
  if (hasMODIFY) {
    const lower = description.toLowerCase();
    if (/新建|创建|create|add.*file/.test(lower)) return 'create';
    return 'edit';
  }
  if (hasREVIEW) return 'review';
  if (hasRESEARCH || hasDIAGNOSE) return 'check';
  if (hasANSWER) return 'answer';
  return 'check';
}

export function buildStructuredSummary(
  steps: ExecutedStep[],
  result: { success: boolean; output: string },
  description: string,
): StructuredSummary {
  const modifyStep = [...steps].reverse().find((s) => s.state === State.MODIFY);
  const locateStep = [...steps].reverse().find((s) => s.state === State.LOCATE);
  const verifyStep = [...steps].reverse().find((s) => s.state === State.VERIFY);
  const researchStep = steps.find(
    (s) => s.state === State.RESEARCH || s.state === State.REVIEW || s.state === State.DIAGNOSE,
  );

  let files: string[] = [];
  if (modifyStep) {
    try {
      files = (JSON.parse(modifyStep.output) as { edited?: string[] }).edited ?? [];
    } catch {
      /* skip */
    }
  }

  let locateFiles: string[] = [];
  if (locateStep) {
    try {
      const parsed = JSON.parse(locateStep.output) as { locations?: Array<{ file: string }> };
      locateFiles = (parsed.locations ?? []).map((l) => l.file).filter(Boolean);
    } catch {
      /* skip */
    }
  }

  let verifyPassed: boolean | null = null;
  if (verifyStep) {
    try {
      verifyPassed = (JSON.parse(verifyStep.output) as { passed?: boolean }).passed ?? null;
    } catch {
      /* skip */
    }
  }

  let keyFinding: string | null = null;
  if (researchStep) {
    try {
      const parsed = JSON.parse(researchStep.output) as Record<string, unknown>;
      const raw = (parsed['summary'] ?? parsed['findings'] ?? parsed['rootCause'] ?? '') as string;
      keyFinding = raw.slice(0, 120) || null;
    } catch {
      keyFinding =
        researchStep.output
          .replace(/[{}[\]"]/g, ' ')
          .trim()
          .slice(0, 120) || null;
    }
  }

  const action = inferRunActionType(steps, description);

  return {
    action,
    files,
    locate_files: locateFiles,
    verify_passed: verifyPassed,
    key_finding: keyFinding,
    error_summary: !result.success ? (result.output?.slice(0, 80) ?? null) : null,
  };
}
