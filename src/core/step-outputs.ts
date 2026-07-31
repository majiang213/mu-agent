import { State } from './types.js';
import type { ExecutedStep } from './types.js';

/**
 * Typed reads of a step's complete() output JSON — ONE HOME for the shapes
 * that STATE_REGISTRY's completeSchema declares. Previously each consumer
 * hand-rolled `JSON.parse(output) as …` (prompts, memory extractor, the
 * verify-retry loop, step-context), so a shape change meant hunting through
 * four modules (third-pass review, candidate 12).
 *
 * Every parser is total: malformed input degrades to [] or null, never throws.
 */

/** JSON.parse limited to plain objects; null on any failure. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((f): f is string => typeof f === 'string') : [];
}

/** MODIFY complete() output → edited file list ([] when absent/malformed). */
export function parseEditedFiles(output: string): string[] {
  return stringArray(parseJsonObject(output)?.['edited']);
}

/**
 * MODIFY complete() ARGS (pre-serialization, as captured from the tool call)
 * → edited file list. Same shape knowledge as parseEditedFiles — step-runner
 * reads the captured args object directly instead of re-rolling the access
 * inline (round-4, candidate 6).
 */
export function editedFilesFromArgs(args: Record<string, unknown>): string[] {
  return stringArray(args['edited']);
}

/** LOCATE complete() output → located file paths. */
export function parseLocateFiles(output: string): string[] {
  const locations = parseJsonObject(output)?.['locations'];
  if (!Array.isArray(locations)) return [];
  return locations
    .map((l) => (l !== null && typeof l === 'object' ? (l as Record<string, unknown>)['file'] : null))
    .filter((f): f is string => typeof f === 'string' && f.length > 0);
}

/** VERIFY complete() output — normalized so consumers never read undefined. */
export interface VerifyStepOutput {
  passed: boolean;
  issues: string[];
  summary: string;
}

export function parseVerifyOutput(output: string): VerifyStepOutput | null {
  const obj = parseJsonObject(output);
  if (!obj) return null;
  return {
    passed: obj['passed'] === true,
    issues: stringArray(obj['issues']),
    summary: typeof obj['summary'] === 'string' ? obj['summary'] : '',
  };
}

/**
 * RESEARCH / REVIEW / DIAGNOSE complete() output → the key finding, from the
 * first of the conventional fields. Null when the output is not a JSON object
 * or none of the fields hold a non-empty string.
 */
export function parseKeyFinding(output: string): string | null {
  const obj = parseJsonObject(output);
  if (!obj) return null;
  const raw = obj['summary'] ?? obj['findings'] ?? obj['rootCause'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** Edited files across all MODIFY steps in a result list (dedup preserved to caller). */
export function editedFilesOf(stepResults: ExecutedStep[]): string[] {
  return stepResults.filter((r) => r.state === State.MODIFY).flatMap((r) => parseEditedFiles(r.output));
}
