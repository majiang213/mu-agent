import { describe, it, expect } from 'vitest';
import { isAbortError } from '../../../src/core/agent/abort.js';

describe('isAbortError', () => {
  it('classifies AbortError by name', () => {
    const err = new Error('whatever');
    err.name = 'AbortError';
    expect(isAbortError(err)).toBe(true);
  });

  it('classifies wrapped errors mentioning aborted', () => {
    expect(isAbortError(new Error('The operation was aborted'))).toBe(true);
  });

  it('does NOT false-positive on error text containing bare "abort"', () => {
    expect(isAbortError(new Error('run git merge --abort to cancel the merge'))).toBe(false);
    expect(isAbortError(new Error('AbortController is an interface'))).toBe(false);
  });

  it('rejects real errors and non-errors', () => {
    expect(isAbortError(new Error('ENOENT: no such file'))).toBe(false);
    expect(isAbortError('aborted string is not an Error')).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});
