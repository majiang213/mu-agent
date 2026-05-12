import { describe, it, expect } from 'vitest';
import { TaskDecomposer, createTaskDecomposer, detectTaskType } from '../../src/core/decomposer.js';

describe('detectTaskType', () => {
  it('detects CODING from "实现登录功能"', () => {
    expect(detectTaskType('实现登录功能')).toBe('CODING');
  });

  it('detects BUGFIX from "修复登录bug"', () => {
    expect(detectTaskType('修复登录bug')).toBe('BUGFIX');
  });

  it('detects TESTING from "写测试"', () => {
    expect(detectTaskType('写测试')).toBe('TESTING');
  });

  it('detects DOCUMENTATION from "更新README"', () => {
    expect(detectTaskType('更新README')).toBe('DOCUMENTATION');
  });

  it('detects REVIEW from "代码审查"', () => {
    expect(detectTaskType('代码审查')).toBe('REVIEW');
  });

  it('returns UNKNOWN for unrecognized task', () => {
    expect(detectTaskType('zzz xyz abc')).toBe('UNKNOWN');
  });
});

describe('TaskDecomposer', () => {
  describe('factory', () => {
    it('createTaskDecomposer returns TaskDecomposer instance', () => {
      expect(createTaskDecomposer()).toBeInstanceOf(TaskDecomposer);
    });
  });

  describe('Level 1 — sequential patterns', () => {
    it('decomposes Chinese sequential prompt (先...然后...)', async () => {
      const d = new TaskDecomposer();
      const r = await d.decompose('先修复登录bug然后写测试');
      expect(r.level).toBe(1);
      expect(r.tasks.length).toBeGreaterThanOrEqual(2);
      expect(r.tasks[0]!.dependencies).toHaveLength(0);
      expect(r.tasks[1]!.dependencies).toContain('seq-0');
    });

    it('decomposes numbered list (1. ... 2. ...)', async () => {
      const d = new TaskDecomposer();
      const r = await d.decompose('1. implement login 2. write tests 3. update docs');
      expect(r.level).toBe(1);
      expect(r.tasks.length).toBeGreaterThanOrEqual(2);
    });

    it('sequential tasks have chained dependencies', async () => {
      const d = new TaskDecomposer();
      const r = await d.decompose('先实现功能然后写测试再更新文档');
      const ids = r.tasks.map((t) => t.id);
      for (let i = 1; i < r.tasks.length; i++) {
        expect(r.tasks[i]!.dependencies).toContain(ids[i - 1]);
      }
    });

    it('confidence >= 0.8 for sequential', async () => {
      const d = new TaskDecomposer();
      const r = await d.decompose('先修复bug然后写测试');
      expect(r.confidence).toBeGreaterThanOrEqual(0.8);
    });
  });

  describe('Level 1 — parallel patterns', () => {
    it('decomposes comma-separated parallel tasks', async () => {
      const d = new TaskDecomposer();
      const r = await d.decompose('实现功能、写测试、更新文档');
      expect(r.level).toBe(1);
      expect(r.tasks.every((t) => t.parallel === true)).toBe(true);
      expect(r.tasks.every((t) => t.dependencies.length === 0)).toBe(true);
    });

    it('parallel tasks share same parallelGroup', async () => {
      const d = new TaskDecomposer();
      const r = await d.decompose('实现功能、写测试、更新文档');
      const groups = new Set(r.tasks.map((t) => t.parallelGroup));
      expect(groups.size).toBe(1);
    });
  });

  describe('Level 1 — mixed patterns', () => {
    it('decomposes mixed sequential+parallel prompt', async () => {
      const d = new TaskDecomposer();
      const r = await d.decompose('先实现功能然后写测试和更新文档');
      expect(r.level).toBe(1);
      expect(r.tasks.length).toBeGreaterThanOrEqual(3);
      const parTasks = r.tasks.filter((t) => t.parallel);
      expect(parTasks.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Level 3 — fallback', () => {
    it('falls back to Level 3 for unstructured prompt', async () => {
      const d = new TaskDecomposer();
      const r = await d.decompose('帮我优化一下这个项目');
      expect(r.level).toBe(3);
      expect(r.tasks).toHaveLength(1);
      expect(r.tasks[0]!.description).toBe('帮我优化一下这个项目');
    });

    it('Level 3 confidence is 1.0', async () => {
      const d = new TaskDecomposer();
      const r = await d.decompose('do something');
      expect(r.confidence).toBe(1.0);
    });

    it('Level 3 task has empty dependencies', async () => {
      const d = new TaskDecomposer();
      const r = await d.decompose('fix the bug');
      expect(r.tasks[0]!.dependencies).toHaveLength(0);
    });
  });

  describe('result shape', () => {
    it('every task has required fields', async () => {
      const d = new TaskDecomposer();
      const r = await d.decompose('先修复bug然后写测试');
      for (const task of r.tasks) {
        expect(typeof task.id).toBe('string');
        expect(typeof task.description).toBe('string');
        expect(typeof task.type).toBe('string');
        expect(Array.isArray(task.dependencies)).toBe(true);
      }
    });
  });
});
