import { describe, it, expect } from 'vitest';
import { retryDelayMs, sleep } from '../../../src/core/failure/index.js';

describe('retryDelayMs', () => {
  it('waits only before the first retry (preserves the collapsed FailureHandler behavior)', () => {
    expect(retryDelayMs(0)).toBe(1000);
    expect(retryDelayMs(1)).toBe(0);
    expect(retryDelayMs(5)).toBe(0);
  });

  it('honors a custom base', () => {
    expect(retryDelayMs(0, 250)).toBe(250);
  });
});

describe('sleep', () => {
  it('is a no-op for 0ms', async () => {
    const start = Date.now();
    await sleep(0);
    expect(Date.now() - start).toBeLessThan(50);
  });
});
