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
    it('returns empty steps with no error for empty array (valid for direct Q&A)', () => {
      const { steps, error } = parseReasonSteps({ steps: [] });
      expect(steps).toHaveLength(0);
      expect(error).toBeNull();
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

  describe('parallel directives', () => {
    it('parses a parallel group as a single directive', () => {
      const { steps, error } = parseReasonSteps({
        steps: [
          { state: 'LOCATE', focus: 'find files' },
          {
            parallel: [
              { state: 'MODIFY', focus: 'fix calc.js' },
              { state: 'MODIFY', focus: 'fix server.js' },
            ],
          },
          { state: 'VERIFY', focus: 'run tests' },
        ],
      });
      expect(error).toBeNull();
      expect(steps).toHaveLength(3);
      const second = steps[1]!;
      expect('parallel' in second).toBe(true);
      if ('parallel' in second) {
        expect(second.parallel).toHaveLength(2);
        expect(second.parallel[0]!.state).toBe(State.MODIFY);
        expect(second.parallel[1]!.state).toBe(State.MODIFY);
      }
    });

    it('filters out invalid steps inside a parallel group', () => {
      const { steps, error } = parseReasonSteps({
        steps: [
          {
            parallel: [
              { state: 'INVALID_STATE', focus: 'bad step' },
              { state: 'MODIFY', focus: 'valid step' },
            ],
          },
        ],
      });
      expect(error).toBeNull();
      expect(steps).toHaveLength(1);
      const first = steps[0]!;
      if ('parallel' in first) {
        expect(first.parallel).toHaveLength(1);
        expect(first.parallel[0]!.state).toBe(State.MODIFY);
      }
    });

    it('skips parallel directive entirely if all inner steps are invalid', () => {
      const { steps, error } = parseReasonSteps({
        steps: [
          {
            parallel: [
              { state: 'BAD', focus: 'x' },
              { state: 'ALSO_BAD', focus: 'y' },
            ],
          },
          { state: 'VERIFY', focus: 'run tests' },
        ],
      });
      expect(steps).toHaveLength(1);
      expect(error).toBeNull();
      expect(steps[0]!).toMatchObject({ state: State.VERIFY });
    });

    it('mixes sequential and parallel directives in one plan', () => {
      const { steps, error } = parseReasonSteps({
        steps: [
          { state: 'LOCATE', focus: 'find affected files' },
          {
            parallel: [
              { state: 'MODIFY', focus: 'edit A' },
              { state: 'MODIFY', focus: 'edit B' },
            ],
          },
          { state: 'VERIFY', focus: 'run tests' },
        ],
      });
      expect(error).toBeNull();
      expect(steps).toHaveLength(3);
      expect('state' in steps[0]!).toBe(true);
      expect('parallel' in steps[1]!).toBe(true);
      expect('state' in steps[2]!).toBe(true);
    });
  });

  describe('subplan directives (Gap 80)', () => {
    it('parses a valid subplan directive', () => {
      const { steps, error } = parseReasonSteps({
        steps: [{ subplan: { analyzerState: 'PLAN', focus: 'analyze git changes and plan commits' } }],
      });
      expect(error).toBeNull();
      expect(steps).toHaveLength(1);
      const first = steps[0]!;
      expect('subplan' in first).toBe(true);
      if ('subplan' in first) {
        expect(first.subplan.analyzerState).toBe(State.PLAN);
        expect(first.subplan.focus).toBe('analyze git changes and plan commits');
      }
    });

    it('rejects subplan with empty focus', () => {
      const { steps } = parseReasonSteps({
        steps: [{ subplan: { analyzerState: 'PLAN', focus: '' } }],
      });
      expect(steps).toHaveLength(0);
    });

    it('rejects subplan with non-string analyzerState', () => {
      const { steps } = parseReasonSteps({
        steps: [{ subplan: { analyzerState: 123, focus: 'do something' } }],
      });
      expect(steps).toHaveLength(0);
    });

    it('mixes subplan with regular sequential steps', () => {
      const { steps, error } = parseReasonSteps({
        steps: [
          { state: 'VERIFY', focus: 'run tests' },
          { subplan: { analyzerState: 'PLAN', focus: 'plan atomic commits' } },
        ],
      });
      expect(error).toBeNull();
      expect(steps).toHaveLength(2);
      expect('state' in steps[0]!).toBe(true);
      expect('subplan' in steps[1]!).toBe(true);
    });

    it('mixes subplan with parallel directive', () => {
      const { steps, error } = parseReasonSteps({
        steps: [
          {
            parallel: [
              { state: 'MODIFY', focus: 'fix A' },
              { state: 'MODIFY', focus: 'fix B' },
            ],
          },
          { subplan: { analyzerState: 'PLAN', focus: 'plan commits after fix' } },
        ],
      });
      expect(error).toBeNull();
      expect(steps).toHaveLength(2);
      expect('parallel' in steps[0]!).toBe(true);
      expect('subplan' in steps[1]!).toBe(true);
    });

    it('counts subplan toward the 6-directive cap', () => {
      const { steps } = parseReasonSteps({
        steps: [
          { state: 'LOCATE', focus: 'f1' },
          { state: 'MODIFY', focus: 'f2' },
          { state: 'VERIFY', focus: 'f3' },
          { state: 'RESEARCH', focus: 'f4' },
          { state: 'DIAGNOSE', focus: 'f5' },
          { state: 'ANSWER', focus: 'f6' },
          { subplan: { analyzerState: 'PLAN', focus: 'truncated' } },
        ],
      });
      expect(steps).toHaveLength(6);
      expect(steps.every((d) => !('subplan' in d))).toBe(true);
    });

    it('accepts PLAN as a valid analyzerState (State enum value)', () => {
      const { steps, error } = parseReasonSteps({
        steps: [{ subplan: { analyzerState: 'PLAN', focus: 'run tests and plan fix steps' } }],
      });
      expect(error).toBeNull();
      expect(steps).toHaveLength(1);
    });
  });
});
