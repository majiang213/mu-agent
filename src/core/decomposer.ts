import type { SubTask, TaskType, DecompositionResult } from './types.js';
import type { LLMConnector } from '../provider/llm.js';
import type { DecompositionConfig } from '../config/types.js';

const SEQUENTIAL_PATTERNS = [
  /先(.+?)然后(.+?)(?:再(.+?))?(?:最后(.+?))?$/,
  /首先(.+?)接着(.+?)(?:然后(.+?))?(?:最后(.+?))?$/,
  /第一步(.+?)第二步(.+?)(?:第三步(.+?))?$/,
  /1\.\s*(.+?)2\.\s*(.+?)(?:3\.\s*(.+?))?/,
  /first[,\s]+(.+?)[,\s]+then[,\s]+(.+?)(?:[,\s]+finally[,\s]+(.+?))?$/i,
];

const PARALLEL_PATTERNS = [
  /^(.+?)\s*[,，、]\s*(.+?)\s*[,，、]\s*(.+?)$/,
  /^(.+?)\s*和\s*(.+?)\s*和\s*(.+?)$/,
  /^(.+?)\s+and\s+(.+?)\s+and\s+(.+?)$/i,
];

const MIXED_PATTERN = /先(.+?)然后(.+?)和(.+?)(?:最后(.+?))?$/;

const TASK_TYPE_KEYWORDS: Record<TaskType, string[]> = {
  CODING: ['实现', '开发', '编写', '写代码', 'implement', 'add', 'create', 'build', 'code'],
  BUGFIX: ['修复', '修bug', 'fix', 'bug', 'error', 'broken', '错误'],
  REFACTORING: ['重构', '优化', 'refactor', 'refactoring', 'clean', 'improve'],
  TESTING: ['测试', '写测试', 'test', 'spec', 'unit test', '单测'],
  DOCUMENTATION: ['文档', 'readme', 'docs', 'document', '注释', 'comment'],
  REVIEW: ['审查', '审核', 'review', 'check', '检查'],
  ANALYSIS: ['分析', '调查', 'analyze', 'investigate', 'research', '研究'],
  UNKNOWN: [],
};

export function detectTaskType(description: string): TaskType {
  const lower = description.toLowerCase();
  for (const [type, keywords] of Object.entries(TASK_TYPE_KEYWORDS) as [TaskType, string[]][]) {
    if (type === 'UNKNOWN') continue;
    if (keywords.some((kw) => lower.includes(kw))) return type;
  }
  return 'UNKNOWN';
}

function makeTasks(parts: string[], parallel: boolean): SubTask[] {
  return parts.map((desc, i) => ({
    id: parallel ? `par-${i}` : `seq-${i}`,
    description: desc.trim(),
    type: detectTaskType(desc),
    dependencies: parallel ? [] : i > 0 ? [`seq-${i - 1}`] : [],
    ...(parallel ? { parallel: true, parallelGroup: 'group-0' } : {}),
  }));
}

function trySequential(prompt: string): SubTask[] | null {
  for (const pattern of SEQUENTIAL_PATTERNS) {
    const m = prompt.match(pattern);
    if (m) {
      const parts = m.slice(1).filter(Boolean);
      if (parts.length >= 2) return makeTasks(parts, false);
    }
  }
  return null;
}

function tryParallel(prompt: string): SubTask[] | null {
  for (const pattern of PARALLEL_PATTERNS) {
    const m = prompt.match(pattern);
    if (m) {
      const parts = m.slice(1).filter(Boolean);
      if (parts.length >= 2) return makeTasks(parts, true);
    }
  }
  return null;
}

function tryMixed(prompt: string): SubTask[] | null {
  const m = prompt.match(MIXED_PATTERN);
  if (!m) return null;
  const [, first, parA, parB, last] = m;
  if (!first || !parA || !parB) return null;

  const tasks: SubTask[] = [];
  tasks.push({ id: 'mix-0', description: first.trim(), type: detectTaskType(first), dependencies: [] });
  tasks.push({ id: 'mix-1', description: parA.trim(), type: detectTaskType(parA), dependencies: ['mix-0'], parallel: true, parallelGroup: 'mix-par' });
  tasks.push({ id: 'mix-2', description: parB.trim(), type: detectTaskType(parB), dependencies: ['mix-0'], parallel: true, parallelGroup: 'mix-par' });
  if (last) {
    tasks.push({ id: 'mix-3', description: last.trim(), type: detectTaskType(last), dependencies: ['mix-1', 'mix-2'] });
  }
  return tasks;
}

function validateTasks(tasks: SubTask[], maxSubTasks = 5): boolean {
  if (tasks.length === 0 || tasks.length > maxSubTasks) return false;
  const ids = new Set(tasks.map((t) => t.id));
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (!ids.has(dep)) return false;
    }
    if (!task.description.trim()) return false;
  }
  return true;
}

function level3Fallback(prompt: string): SubTask[] {
  return [{ id: 'task-0', description: prompt.trim(), type: detectTaskType(prompt), dependencies: [] }];
}

const LEVEL2_SYSTEM_PROMPT = `You are a task decomposition assistant. Break a coding task into 2-3 sequential subtasks.
Output ONLY valid JSON, no other text.
Format: {"tasks": [{"id": "l2-0", "description": "...", "type": "CODING|BUGFIX|REFACTORING|TESTING|DOCUMENTATION|REVIEW|ANALYSIS|UNKNOWN"}, ...]}
Rules: max 3 tasks, each description under 80 chars, sequential order.`;

const LEVEL2_FEW_SHOT = `Example:
Input: "重构认证系统并添加 OAuth 支持"
Output: {"tasks": [{"id": "l2-0", "description": "分析现有认证系统结构", "type": "ANALYSIS"}, {"id": "l2-1", "description": "重构认证模块为可扩展架构", "type": "REFACTORING"}, {"id": "l2-2", "description": "实现 OAuth 提供商集成", "type": "CODING"}]}`;

const DEFAULT_DECOMPOSITION_CONFIG: DecompositionConfig = {
  enableLevel1: true,
  enableLevel2: false,
  level2MaxTokens: 500,
  maxSubTasks: 6,
};

export class TaskDecomposer {
  private llm: LLMConnector | null;
  private config: DecompositionConfig;

  constructor(llm?: LLMConnector, config?: DecompositionConfig) {
    this.llm = llm ?? null;
    this.config = config ?? DEFAULT_DECOMPOSITION_CONFIG;
  }

  async decompose(prompt: string): Promise<DecompositionResult> {
    const trimmed = prompt.trim();
    const { enableLevel1, enableLevel2, maxSubTasks } = this.config;

    if (enableLevel1) {
      const mixed = tryMixed(trimmed);
      if (mixed && validateTasks(mixed, maxSubTasks)) {
        return { tasks: mixed, level: 1, confidence: 0.85 };
      }

      const seq = trySequential(trimmed);
      if (seq && validateTasks(seq, maxSubTasks)) {
        return { tasks: seq, level: 1, confidence: 0.9 };
      }

      const par = tryParallel(trimmed);
      if (par && validateTasks(par, maxSubTasks)) {
        return { tasks: par, level: 1, confidence: 0.8 };
      }
    }

    if (enableLevel2 && this.llm) {
      const level2 = await this.tryLevel2LLM(trimmed);
      if (level2) {
        return { tasks: level2, level: 2, confidence: 0.6 };
      }
    }

    return { tasks: level3Fallback(trimmed), level: 3, confidence: 1.0 };
  }

  private async tryLevel2LLM(prompt: string): Promise<SubTask[] | null> {
    if (!this.llm) return null;
    try {
      const userPrompt = `${LEVEL2_FEW_SHOT}\n\nInput: "${prompt}"\nOutput:`;
      const { content } = await this.llm.generate(LEVEL2_SYSTEM_PROMPT, userPrompt);

      const start = content.indexOf('{');
      const end = content.lastIndexOf('}');
      if (start === -1 || end === -1) return null;

      const parsed = JSON.parse(content.slice(start, end + 1)) as { tasks?: Array<{ id: string; description: string; type: string }> };
      if (!Array.isArray(parsed.tasks) || parsed.tasks.length < 2 || parsed.tasks.length > 3) return null;

      const tasks: SubTask[] = parsed.tasks.map((t, i) => ({
        id: t.id ?? `l2-${i}`,
        description: t.description?.slice(0, 120) ?? '',
        type: (t.type as TaskType) ?? 'UNKNOWN',
        dependencies: i > 0 ? [(parsed.tasks![i - 1]?.id ?? `l2-${i - 1}`)] : [],
      }));

      return validateTasks(tasks) ? tasks : null;
    } catch {
      return null;
    }
  }
}

export function createTaskDecomposer(): TaskDecomposer {
  return new TaskDecomposer();
}
