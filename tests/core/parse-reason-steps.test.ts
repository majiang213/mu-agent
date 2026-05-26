import { describe, it, expect } from 'vitest';
import { parseReasonSteps } from '../../src/core/agent/step-runner.js';
import { State } from '../../src/core/types.js';

describe('parseReasonSteps', () => {
  describe('null / missing input', () => {
    it('returns empty steps and error when input is null', () => {
      const { steps, error } = parseReasonSteps(null);
      expect(steps).toHaveLength(0);
      expect(error).toBeTruthy();
    });

    it('returns error when steps field is missing', () => {
      const { steps, error } = parseReasonSteps({ other: 'field' });
      expect(steps).toHaveLength(0);
      expect(error).toContain('steps must be an array');
    });

    it('returns error when steps is not an array', () => {
      const { steps, error } = parseReasonSteps({ steps: 'LOCATE' });
      expect(steps).toHaveLength(0);
      expect(error).toBeTruthy();
    });
  });

  describe('empty steps array', () => {
    it('returns empty steps and error for empty array', () => {
      const { steps, error } = parseReasonSteps({ steps: [] });
      expect(steps).toHaveLength(0);
      expect(error).toContain('empty');
    });
  });

  describe('valid steps', () => {
    it('parses a single valid step', () => {
      const { steps, error } = parseReasonSteps({
        steps: [{ state: 'LOCATE', focus: 'find login function' }],
      });
      expect(error).toBeNull();
      expect(steps).toHaveLength(1);
      expect(steps[0]!.state).toBe(State.LOCATE);
      expect(steps[0]!.focus).toBe('find login function');
    });

    it('parses a full coding pipeline', () => {
      const { steps, error } = parseReasonSteps({
        steps: [
          { state: 'LOCATE', focus: 'find the bug' },
          { state: 'MODIFY', focus: 'fix the bug' },
          { state: 'VERIFY', focus: 'run tests' },
        ],
      });
      expect(error).toBeNull();
      expect(steps).toHaveLength(3);
      expect(steps.map((s) => s.state)).toEqual([State.LOCATE, State.MODIFY, State.VERIFY]);
    });

    it('parses ANSWER step for chitchat', () => {
      const { steps, error } = parseReasonSteps({
        steps: [{ state: 'ANSWER', focus: 'respond to greeting' }],
      });
      expect(error).toBeNull();
      expect(steps[0]!.state).toBe(State.ANSWER);
    });

    it('accepts all valid State enum values', () => {
      const validStates = [
        'LOCATE',
        'MODIFY',
        'VERIFY',
        'REASON',
        'ANSWER',
        'DIAGNOSE',
        'REVIEW',
        'RUN',
        'RESEARCH',
        'SETUP',
        'TEST_WRITE',
        'REFACTOR_PLAN',
        'ROLLBACK',
      ];
      for (const state of validStates) {
        const { steps, error } = parseReasonSteps({
          steps: [{ state, focus: 'some focus' }],
        });
        expect(error).toBeNull();
        expect(steps[0]!.state).toBe(state);
      }
    });
  });

  describe('invalid steps — filtering', () => {
    it('filters out steps with invalid state name', () => {
      const { steps, error } = parseReasonSteps({
        steps: [
          { state: 'INVALID_STATE', focus: 'do something' },
          { state: 'MODIFY', focus: 'valid step' },
        ],
      });
      expect(steps).toHaveLength(1);
      expect(steps[0]!.state).toBe(State.MODIFY);
      expect(error).toBeNull();
    });

    it('filters out steps with empty focus', () => {
      const { steps, error } = parseReasonSteps({
        steps: [
          { state: 'LOCATE', focus: '' },
          { state: 'MODIFY', focus: 'fix it' },
        ],
      });
      expect(steps).toHaveLength(1);
      expect(steps[0]!.state).toBe(State.MODIFY);
    });

    it('filters out non-object entries', () => {
      const { steps, error } = parseReasonSteps({
        steps: [null, 'string', 42, { state: 'ANSWER', focus: 'valid' }],
      });
      expect(steps).toHaveLength(1);
      expect(steps[0]!.state).toBe(State.ANSWER);
    });

    it('returns error when all entries are invalid', () => {
      const { steps, error } = parseReasonSteps({
        steps: [
          { state: 'INVALID', focus: 'x' },
          { state: 'ALSO_BAD', focus: 'y' },
        ],
      });
      expect(steps).toHaveLength(0);
      expect(error).toContain('Invalid entries');
    });
  });

  describe('max 6 steps cap', () => {
    it('returns at most 6 steps', () => {
      const manySteps = Array(10).fill({ state: 'LOCATE', focus: 'find something' });
      const { steps, error } = parseReasonSteps({ steps: manySteps });
      expect(error).toBeNull();
      expect(steps).toHaveLength(6);
    });

    it('returns exactly 6 when input has exactly 6', () => {
      const sixSteps = Array(6).fill({ state: 'MODIFY', focus: 'change something' });
      const { steps } = parseReasonSteps({ steps: sixSteps });
      expect(steps).toHaveLength(6);
    });
  });
});
