/**
 * Provider vocabulary — ONE table (round-7, candidate 6). Previously the set
 * of providers and their facts lived in five places: the config type union,
 * the loader validator array, the CLI flag parser, the setup wizard's item
 * list, and the default-URL map. Adding a provider now means adding one row.
 *
 * needsModelSize: ollama probes parameter count dynamically (/api/show);
 * unsloth/custom can't, so the wizard asks and config carries modelSize
 * (AGENTS.md design principle 7).
 */
export const PROVIDER_FACTS = [
  {
    name: 'ollama',
    description: 'Local Ollama server (default: localhost:11434)',
    defaultBaseUrl: 'http://localhost:11434',
    needsModelSize: false,
  },
  {
    name: 'unsloth',
    description: 'Unsloth Studio (default: localhost:8888)',
    defaultBaseUrl: 'http://localhost:8888',
    needsModelSize: true,
  },
  {
    name: 'custom',
    description: 'OpenAI-compatible API',
    defaultBaseUrl: '',
    needsModelSize: true,
  },
] as const;

export type ProviderName = (typeof PROVIDER_FACTS)[number]['name'];

/** Display/validation enumeration (CLI error messages, loader validation). */
export const PROVIDER_NAMES: readonly string[] = PROVIDER_FACTS.map((f) => f.name);

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

export function providerFacts(name: ProviderName): (typeof PROVIDER_FACTS)[number] {
  // Index by name — the table is 3 rows; a find is clearer than a Map here.
  const row = PROVIDER_FACTS.find((f) => f.name === name);
  if (!row) throw new Error(`unknown provider: ${name}`);
  return row;
}

export function defaultBaseUrl(name: ProviderName): string {
  return providerFacts(name).defaultBaseUrl;
}
