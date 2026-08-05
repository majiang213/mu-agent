import type { SelectItem } from '@earendil-works/pi-tui';
import { PROVIDER_FACTS } from '../provider/providers.js';
import type { ProviderName } from '../provider/providers.js';

/**
 * Setup-wizard decision logic, terminal-free (round-7, candidate 5). These
 * used to live inside interactive step methods — testing them meant mocking
 * all of pi-tui. The wizard (setup.ts) keeps widget choreography; every
 * branch that decides something lives here.
 */

/**
 * modelSize input parse: blank = skip (treated as a large model — tier
 * defaults to LARGE); a finite positive number is kept; junk is dropped.
 */
export function parseModelSizeInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  const parsed = trimmed === '' ? NaN : Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Wizard provider select items, derived from the one facts table (round-7, C6). */
export function providerSelectItems(): Array<SelectItem & { value: ProviderName }> {
  return PROVIDER_FACTS.map((f) => ({ value: f.name, label: f.name, description: f.description }));
}

/** The wizard asks for modelSize only when the provider can't probe it (AGENTS principle 7). */
export function providerNeedsModelSize(provider: ProviderName): boolean {
  return PROVIDER_FACTS.find((f) => f.name === provider)?.needsModelSize ?? false;
}
