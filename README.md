# local-agent

基于 [pi](https://github.com/mariozechner/pi) 框架的本地 ReAct Coding Agent，专为 7B/8B 小模型设计。

---

## 为什么需要针对小模型的专项优化？

大模型（GPT-4、Claude 3.5）在 Agent 任务上表现出色，但在本地 7B/8B 模型上，同样的方法会大幅失效。根据学术研究（*Small LLMs Are Weak Tool Learners*, 2024）和 Agentless（ICSE 2025）的实验结论，小模型有五个核心痛点：

| 痛点 | 具体表现 |
|------|---------|
| **上下文爆炸** | 7B 模型上下文窗口小（通常 4k-32k），长任务很快超限 |
| **错误重复** | 遇到错误后不会换策略，反复尝试同一种失败方法 |
| **工具调用弱** | 自主选择工具时经常选错，或调用格式不符合要求 |
| **代码定位靠猜** | 不能精确定位需要修改的函数/类，容易改错地方 |
| **无法处理复杂任务** | 一次性处理多步骤任务时容易迷失，遗忘前置步骤 |

local-agent 针对这五个痛点逐一设计了解法。

---

## 核心设计：受约束的 ReAct 循环

这是本项目最核心的架构原则，来自 Agentless（ICSE 2025）的实验结论：

> **确定性流水线优于让 LLM 自主规划。** 给小模型一个清晰的、受约束的任务，比让它自己决定下一步做什么，成功率高出 40%+。

local-agent 使用 **pi AgentLoop** 驱动真实的 ReAct 循环（LLM → 工具调用 → 结果回传 → LLM），状态机作为**拦截器**介入，约束 LLM 的行为边界：

```
传统 ReAct Agent:
  LLM 自主决定：用哪个工具？→ 工具执行 → 结果回传 → 下一步...
  问题：7B 模型在规划层面非常弱，容易调用错误工具或陷入循环

local-agent:
  pi AgentLoop：LLM 自主决定工具调用 → 工具真实执行 → 结果回传 → LLM
  状态机拦截：当前状态不允许的工具 → 自动 block，LLM 换策略
  状态转换：达到迭代上限 → 注入新 system prompt 引导进入下一阶段
  优势：LLM 保留自主决策能力，但被约束在合理范围内
```

---

## 五大优化详解

### 1. 状态机约束的 ReAct 循环 — 解决「工具调用弱」和「无法处理复杂任务」

每个任务经过固定的状态流转，每个状态只开放必要的工具：

```
ANALYZE → LOCATE → MODIFY → VERIFY → DONE
```

| 状态 | 开放工具 | LLM 的任务 |
|------|---------|-----------|
| ANALYZE | read, grep, find, ls | 理解需求，输出分析摘要 |
| LOCATE | read, grep, find, ls | 找到需要修改的具体位置 |
| MODIFY | edit, write | 生成代码修改 |
| VERIFY | read, bash | 验证修改是否正确 |

**效果：** LLM 在 MODIFY 状态下尝试 grep 文件时，`beforeToolCall` 会自动 block 并告知原因，LLM 收到提示后换策略。行为边界由代码强制约束，而非依赖 LLM 的自律。

状态机还会根据模型规模动态调整约束强度：

```typescript
// 7B 小模型：严格模式
{ maxFilesPerTask: 2, maxRetries: 1, strictPlanning: true }

// 30B 中模型：适中模式
{ maxFilesPerTask: 4, maxRetries: 2, strictPlanning: true }

// 70B+ 大模型：宽松模式
{ maxFilesPerTask: 8, maxRetries: 3, strictPlanning: false }
```

---

### 2. 分层任务分解 — 解决「无法处理复杂任务」

复杂任务在交给 LLM 前，先用**零 LLM 的规则引擎**分解：

```
Level 1: 规则分解（零 LLM 调用，~70% 任务覆盖）
  识别顺序模式：先A然后B再C → [A→B→C]
  识别并行模式：A、B、C → [A ∥ B ∥ C]
  识别混合模式：先A然后B和C最后D → [A→{B∥C}→D]

Level 2: 结构化验证（规则校验，最多 3 个子任务）

Level 3: 单任务保底（100% 成功率兜底）
```

每个子任务独立进入状态机执行，LLM 的上下文始终保持最小化。

**效果：** 「先修复登录bug然后写测试」会被分解为两个独立任务，分别在各自的状态机实例中执行，互不干扰。

---

### 3. Token 预算制上下文压缩 — 解决「上下文爆炸」

7B 模型上下文窗口有限，长任务必然超限。local-agent 实现了 Head/Tail 分离压缩：

```
完整上下文（超限时触发）:
  [历史消息 HEAD] [最近消息 TAIL]
         ↓ 压缩
  [摘要 SUMMARY] [最近消息 TAIL]
```

关键参数（可配置）：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| reserveTokens | 2000 | 为 LLM 回复预留的 token |
| preserveRecentTokens | 4000 | 始终保留的最近消息 |
| maxSummaryLength | 200 | 摘要最大长度 |

**效果：** 即使任务历史很长，LLM 每次收到的上下文都控制在窗口限制以内，避免截断导致的信息丢失。

---

### 4. 停滞检测（Stagnation Detection）— 解决「错误重复」

小模型遇到失败后容易陷入无效循环，local-agent 通过停滞检测主动识别并中止：

```
检测规则（满足任一即触发）:
  ① 连续 3 次执行相同 action（工具 + 参数完全相同）
  ② 连续 3 次错误，且错误类型相同
  ③ 连续 5 次只有 ANALYZE，没有实际 MODIFY
  ④ 状态循环（ANALYZE→LOCATE→ANALYZE 超过 2 次）
```

触发后进入失败处理流程，而不是继续浪费 token。

**效果：** 避免「反复读同一个文件 10 次」「一直分析但不动手」这类常见的小模型卡死场景。

---

### 5. AST 精确代码定位 — 解决「代码定位靠猜」

基于 TypeScript Compiler API 实现真正的 AST 解析，不依赖正则或 LLM 猜测：

```typescript
// 精确找到函数定义，返回准确行号
const results = await locator.search({
  query: 'login',
  scope: 'src/',
  limit: 5,
});
// 返回:
// { functionName: 'login', filePath: 'src/auth.ts',
//   location: { startLine: 42, endLine: 58 },
//   kind: 'function', score: 1.0 }
```

支持四种符号类型：`function`、`class`、`method`、`arrow`，行号精确到 AST 节点级别。

**效果：** LLM 在 LOCATE 阶段拿到的是精确的文件路径 + 行号，而不是需要自己在文件里搜索。修改时直接定位，不会改错位置。

---

### 6. 四层失败降级 — 综合保障

```
Level 1: 同任务重试（最多 3 次，每次调整参数）
         → 第 1 次：提高 temperature，换思路
         → 第 2 次：补充更多上下文
         → 第 3 次：简化任务描述

Level 2: 子任务分解（把失败的任务拆得更细）

Level 3: 人工介入（提示用户提供额外信息或跳过）

Level 4: 单任务保底（整个 prompt 作为一个任务，100% 不崩溃）
```

---

## 与通用 Agent 框架的对比

| 特性 | LangChain/AutoGPT | local-agent |
|------|-------------------|-------------|
| 目标模型 | GPT-4/Claude | 本地 7B/8B |
| 任务规划 | LLM 自主决定 | 状态机约束的 ReAct 循环 |
| 工具选择 | LLM 自主选择 | 按状态限制 |
| 上下文管理 | 依赖模型窗口 | Token 预算制压缩 |
| 失败处理 | 报错退出 | 四层降级策略 |
| 代码定位 | LLM 搜索 | AST 精确定位 |
| 停滞检测 | 无 | Stagnation Detection |
| 隐私 | 数据上云 | 完全本地 |

---

## 环境要求

- Node.js 20+
- [Ollama](https://ollama.ai)（本地模型运行时）
- 已拉取模型，例如 `ollama pull qwen3.5:9b`

## 安装

```bash
npm install
```

## 使用

### TUI 交互模式（推荐）

```bash
npx tsx src/cli.ts tui
```

指定模型：

```bash
npx tsx src/cli.ts tui -m qwen3.5:9b -p ollama -u http://localhost:11434
```

TUI 界面布局：

```
 ~/project  │  main  │  qwen3.5:9b  │  ANALYZE [1/2]  │  ctx 12%
─────────────────────────────────────────────────────────────────
 准备就绪，输入任务后按 Enter 执行

─── 先修复登录bug然后写测试 ───
  分解为 2 个子任务
─── 子任务 1/2: 修复登录bug ───
  [LOCATE]
    > read
  [MODIFY]
  ✅ 子任务 1 完成

 ⠸ 执行中... [2/2]
─────────────────────────────────────────────────────────────────
 > 输入任务描述
```

| 快捷键 | 功能 |
|--------|------|
| `Enter` | 执行任务 |
| `↑` / `↓` | 历史任务导航 |
| `Ctrl+L` | 清屏 |
| `Ctrl+C` / `Esc` | 退出 |

### CLI 单次执行

```bash
npx tsx src/cli.ts run "修复 src/auth.ts 中的登录 bug"
npx tsx src/cli.ts run "先修复登录bug然后写测试" -m qwen3.5:9b
```

### 其他命令

```bash
npx tsx src/cli.ts config     # 查看当前配置
npx tsx src/cli.ts sysinfo    # 查看硬件信息
```

## 任务分解语法

Agent 支持结构化任务描述，会自动识别并分解：

| 模式 | 示例 | 结果 |
|------|------|------|
| 顺序 | `先修复bug然后写测试` | task1 → task2 |
| 并行 | `实现功能、写测试、更新文档` | task1 \|\| task2 \|\| task3 |
| 混合 | `先实现功能然后写测试和更新文档` | task1 → {task2 \|\| task3} |
| 单任务 | `优化性能` | task1（保底模式） |

## 状态机

每个子任务经过以下状态：

```
ANALYZE → LOCATE → MODIFY → VERIFY → DONE
```

| 状态 | 工具 | 目标 |
|------|------|------|
| ANALYZE | read, grep, find, ls | 理解任务，识别文件 |
| LOCATE | read, grep, find, ls | 定位精确修改位置 |
| MODIFY | read, edit, write | 应用代码修改 |
| VERIFY | read, bash | 验证修改正确 |

## 项目结构

```
src/
├── cli.ts                  # CLI 入口
├── core/                   # Agent 运行时
│   ├── session.ts          # 状态机（工具拦截 + 状态转换）
│   ├── agent.ts            # 任务调度器（pi AgentLoop 驱动真实 ReAct）
│   ├── decomposer.ts       # 任务分解器（Level 1/2/3）
│   ├── metrics.ts          # 性能追踪
│   ├── types.ts            # 核心类型
│   ├── compaction/         # 上下文压缩
│   ├── cognitive/          # 停滞检测（Stagnation Detection）
│   └── failure/            # 失败处理
├── provider/               # LLM 层
│   ├── llm.ts              # LLM 连接器（pi-ai + Ollama）
│   ├── llm-service.ts      # 状态感知调用
│   └── prompt.ts           # Prompt 构建器
├── tool/                   # 工具层
│   ├── executor.ts         # 工具执行器（辅助，主执行由 pi codingTools 承担）
│   ├── locator.ts          # AST 定位器
│   └── safety/             # 安全修改
├── tui/                    # TUI 界面
│   ├── app.ts              # 主应用
│   └── components/         # Header / MessageLog / StatusBar
├── config/                 # 配置管理
└── sysinfo/                # 硬件监控
```

## 开发

```bash
npm test                    # 运行所有测试（123 个）
npx tsc --noEmit            # 类型检查
npx vitest run              # 单次测试
npx vitest                  # 监听模式
```

真实 Ollama 集成测试（需要 Ollama 运行）：

```bash
npx vitest run tests/e2e/ollama-real.test.ts
```

## 技术栈

| 依赖 | 用途 |
|------|------|
| `@mariozechner/pi-ai` | LLM 调用层（openai-completions 兼容） |
| `@mariozechner/pi-agent-core` | Agent 工具系统 |
| `@mariozechner/pi-coding-agent` | 编码工具（read/bash/edit/write） |
| `@mariozechner/pi-tui` | 终端 UI 组件库 |
| `typescript` | AST 解析（Compiler API） |
| `commander` | CLI 框架 |
| `vitest` | 测试框架 |
