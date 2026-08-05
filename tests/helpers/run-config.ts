import { vi } from 'vitest';
import { State } from '../../src/core/types.js';
import type { RunConfig } from '../../src/core/agent/types.js';

/**
 * The ONE home for test RunConfig fixtures (architecture review 2026-08-05,
 * candidate 2). Eleven test files used to hand-roll their own makeCfg with
 * per-file `as unknown as` casts — adding one required RunConfig field broke
 * seven files at once. Deep defaults live here; a test passes only the
 * overrides it actually pins.
 */

export interface StateMachineFakeOptions {
  tier?: 'SMALL' | 'MEDIUM' | 'LARGE';
  /** Extra keys some legacy mocks carry on getModelParams (e.g. maxFilesPerTask). */
  extraParams?: Record<string, unknown>;
}

/** Full-surface StateMachineAgent mock; single-point cast lives here. */
export function makeStateMachineFake(options: StateMachineFakeOptions = {}): RunConfig['stateMachine'] {
  const { tier = 'LARGE', extraParams = {} } = options;
  return {
    clone: vi.fn(function (this: unknown) {
      return this;
    }),
    resetForNextTask: vi.fn(),
    getAllowedTools: vi.fn(() => []),
    getModelParams: vi.fn(() => ({
      tier,
      ...extraParams,
    })),
    getCurrentState: vi.fn(() => State.REASON),
    transitionTo: vi.fn(),
    resetFileBudget: vi.fn(),
    recordToolCall: vi.fn(),
    canModifyMoreFiles: vi.fn(() => true),
    getStateConfig: vi.fn(() => ({ allowedTools: [], prompt: '' })),
  } as unknown as RunConfig['stateMachine'];
}

/** SafeModifier mock with the full checkpoint surface; single-point cast here. */
export function makeSafeModifierFake(): RunConfig['safeModifier'] {
  return {
    createCheckpoint: vi.fn(async () => {}),
    restoreAndClearWhere: vi.fn(async () => {}),
    restore: vi.fn(),
    hasCheckpoint: vi.fn(() => false),
    clearCheckpoint: vi.fn(),
    getCheckpoint: vi.fn(),
  } as unknown as RunConfig['safeModifier'];
}

/**
 * StagnationDetector fake: never detects, records nothing (round-9, candidate 4
 * — the identical 7-line literal lived in both step-runner test files).
 */
export function makeStagnationFake() {
  return {
    recordToolCall: vi.fn(),
    recordError: vi.fn(),
    check: vi.fn(() => ({ detected: false })),
    reset: vi.fn(),
  };
}

/** A RunConfig whose every field is a safe default; override only what the test pins. */
export function makeRunConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    model: {} as RunConfig['model'],
    models: {} as RunConfig['models'],
    stateMachine: makeStateMachineFake(),
    safetyConfig: {},
    locator: null,
    safeModifier: makeSafeModifierFake(),
    env: { cwd: '/tmp', platform: 'linux', isGitRepo: false, date: '2026-01-01' },
    temperature: 0,
    contextRatio: 0.2,
    apiKey: 'test',
    projectRoot: '/tmp',
    registerAgent: vi.fn(),
    unregisterAgent: vi.fn(),
    ...overrides,
  };
}
