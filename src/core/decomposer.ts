import type { Step, IntentType, DecompositionResult } from './types.js';
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

const INTENT_KEYWORDS: Record<IntentType, string[]> = {
  CODING: ['实现', '开发', '编写', '写代码', 'implement', 'add', 'create', 'build', 'code'],
  BUGFIX: ['修复', '修bug', 'fix', 'bug', 'error', 'broken', '错误'],
  REFACTORING: ['重构', '优化', 'refactor', 'refactoring', 'clean', 'improve'],
  TESTING: ['测试', '写测试', 'test', 'spec', 'unit test', '单测'],
  DOCUMENTATION: ['文档', 'readme', 'docs', 'document', '注释', 'comment'],
  REVIEW: ['审查', '审核', 'review', 'check', '检查'],
  ANALYSIS: ['分析', '调查', 'analyze', 'investigate', 'research', '研究'],
  QUESTION: [
    '什么是',
    '为什么',
    '怎么理解',
    '解释',
    '是什么意思',
    'what is',
    'why ',
    'how does',
    'explain',
    'what does',
  ],
  RUN: [
    '跑一下',
    '执行',
    '运行',
    '启动',
    '安装依赖',
    'npm',
    'yarn',
    'pnpm',
    'bun',
    'npx',
    'make',
    'cargo',
    'go run',
    'run',
    'execute',
    'start',
    'install',
    'launch',
  ],
  RESEARCH: [
    '搜索',
    '搜一下',
    '查一下',
    '查找',
    '帮我找',
    '查询',
    '这个网址',
    '这个链接',
    '这个url',
    '看看这个',
    'search',
    'look up',
    'find out',
    'fetch',
    'browse',
    'http://',
    'https://',
    'www.',
  ],
  SETUP: [
    '初始化项目',
    '初始化',
    '生成agents.md',
    '生成配置',
    '分析项目',
    '项目分析',
    '项目配置',
    'init project',
    'initialize',
    'setup project',
    'generate agents.md',
    'agents.md',
  ],
  UNKNOWN: [],
};

export function inferIntent(description: string): IntentType {
  const lower = description.toLowerCase();
  for (const [type, keywords] of Object.entries(INTENT_KEYWORDS) as [IntentType, string[]][]) {
    if (type === 'UNKNOWN') continue;
    if (keywords.some((kw) => lower.includes(kw))) return type;
  }
  return 'UNKNOWN';
}

function makeSteps(parts: string[], parallel: boolean): Step[] {
  return parts.map((desc, i) => ({
    id: parallel ? `par-${i}` : `seq-${i}`,
    description: desc.trim(),
    type: inferIntent(desc),
    dependencies: parallel ? [] : i > 0 ? [`seq-${i - 1}`] : [],
    ...(parallel ? { parallel: true, parallelGroup: 'group-0' } : {}),
  }));
}

function trySequential(prompt: string): Step[] | null {
  for (const pattern of SEQUENTIAL_PATTERNS) {
    const m = prompt.match(pattern);
    if (m) {
      const parts = m.slice(1).filter(Boolean);
      if (parts.length >= 2) return makeSteps(parts, false);
    }
  }
  return null;
}

function tryParallel(prompt: string): Step[] | null {
  for (const pattern of PARALLEL_PATTERNS) {
    const m = prompt.match(pattern);
    if (m) {
      const parts = m.slice(1).filter(Boolean);
      if (parts.length >= 2) return makeSteps(parts, true);
    }
  }
  return null;
}

function tryMixed(prompt: string): Step[] | null {
  const m = prompt.match(MIXED_PATTERN);
  if (!m) return null;
  const [, first, parA, parB, last] = m;
  if (!first || !parA || !parB) return null;

  const steps: Step[] = [];
  steps.push({ id: 'mix-0', description: first.trim(), type: inferIntent(first), dependencies: [] });
  steps.push({
    id: 'mix-1',
    description: parA.trim(),
    type: inferIntent(parA),
    dependencies: ['mix-0'],
    parallel: true,
    parallelGroup: 'mix-par',
  });
  steps.push({
    id: 'mix-2',
    description: parB.trim(),
    type: inferIntent(parB),
    dependencies: ['mix-0'],
    parallel: true,
    parallelGroup: 'mix-par',
  });
  if (last) {
    steps.push({ id: 'mix-3', description: last.trim(), type: inferIntent(last), dependencies: ['mix-1', 'mix-2'] });
  }
  return steps;
}

function validateSteps(steps: Step[], maxSteps = 5): boolean {
  if (steps.length === 0 || steps.length > maxSteps) return false;
  const ids = new Set(steps.map((t) => t.id));
  for (const step of steps) {
    for (const dep of step.dependencies) {
      if (!ids.has(dep)) return false;
    }
    if (!step.description.trim()) return false;
  }
  return true;
}

function level3Fallback(prompt: string): Step[] {
  return [{ id: 'task-0', description: prompt.trim(), type: inferIntent(prompt), dependencies: [] }];
}

import { LEVEL2_SYSTEM_PROMPT, LEVEL2_FEW_SHOT } from './prompts/index.js';

const DEFAULT_DECOMPOSITION_CONFIG: DecompositionConfig = {
  enableLevel1: true,
  enableLevel2: false,
  level2MaxTokens: 500,
  maxSteps: 6,
};

export class Planner {
  private llm: LLMConnector | null;
  private config: DecompositionConfig;

  constructor(llm?: LLMConnector, config?: DecompositionConfig) {
    this.llm = llm ?? null;
    this.config = config ?? DEFAULT_DECOMPOSITION_CONFIG;
  }

  async decompose(prompt: string): Promise<DecompositionResult> {
    const trimmed = prompt.trim();
    const { enableLevel1, enableLevel2, maxSteps } = this.config;

    if (enableLevel1) {
      const mixed = tryMixed(trimmed);
      if (mixed && validateSteps(mixed, maxSteps)) {
        return { tasks: mixed, level: 1, confidence: 0.85 };
      }

      const seq = trySequential(trimmed);
      if (seq && validateSteps(seq, maxSteps)) {
        return { tasks: seq, level: 1, confidence: 0.9 };
      }

      const par = tryParallel(trimmed);
      if (par && validateSteps(par, maxSteps)) {
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

  private async tryLevel2LLM(prompt: string): Promise<Step[] | null> {
    if (!this.llm) return null;
    try {
      const userPrompt = `${LEVEL2_FEW_SHOT}\n\nInput: "${prompt}"\nOutput:`;
      const { content } = await this.llm.generate(LEVEL2_SYSTEM_PROMPT, userPrompt);

      const start = content.indexOf('{');
      const end = content.lastIndexOf('}');
      if (start === -1 || end === -1) return null;

      const parsed = JSON.parse(content.slice(start, end + 1)) as {
        tasks?: Array<{ id: string; description: string; type: string }>;
      };
      if (!Array.isArray(parsed.tasks) || parsed.tasks.length < 2 || parsed.tasks.length > 3) return null;

      const steps: Step[] = parsed.tasks.map((t, i) => ({
        id: t.id ?? `l2-${i}`,
        description: t.description?.slice(0, 120) ?? '',
        type: (t.type as IntentType) ?? 'UNKNOWN',
        dependencies: i > 0 ? [parsed.tasks![i - 1]?.id ?? `l2-${i - 1}`] : [],
      }));

      return validateSteps(steps) ? steps : null;
    } catch {
      return null;
    }
  }
}

export function createPlanner(): Planner {
  return new Planner();
}
