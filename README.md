# local-agent

基于 [pi](https://github.com/mariozechner/pi) 框架的本地 ReAct Coding Agent，专为 7B/8B 小模型设计。

---

## 为什么需要针对小模型的专项优化？

大模型（GPT-4、Claude）在 Agent 任务上表现出色，但在本地 7B/8B 模型上，同样的方法会大幅失效。根据 Agentless（ICSE 2025）和 KWCode 的实践经验，小模型有五个核心痛点：

| 痛点 | 具体表现 |
|------|---------|
| **上下文爆炸** | 小模型上下文窗口有限，长任务很快超限 |
| **错误重复** | 遇到失败后不换策略，反复尝试同一种失败方法 |
| **工具调用弱** | 自主选择工具时经常选错，或调用格式不符合要求 |
| **代码定位靠猜** | 不能精确定位需要修改的函数/类，容易改错地方 |
| **无法处理复杂任务** | 一次性处理多步骤任务时容易迷失 |

local-agent 针对这五个痛点逐一设计了解法。

---

## 核心架构

```
用户输入
  │
  ▼
ReactAgent.run()
  │
  ├── 1. REASON Agent（规划）
  │      tools: [complete]
  │      输出: steps[] = [{state, focus}, ...]
  │
  ├── 2. Step-1 Agent（如 LOCATE）
  │      tools: 按状态白名单
  │      输出: StepHandoff
  │
  └── 3. Step-N Agent（如 MODIFY, VERIFY）
         输入: 原始任务 + 前序 StepHandoff
         输出: StepHandoff
```

每个 Agent 实例完全隔离，只携带该状态允许的工具，避免上下文污染。

---

## 动态任务规划

REASON 状态是任务入口。模型分析用户输入，调用 `complete()` 提交执行计划：

```
用户: "修复登录 bug"
REASON 输出:
  steps=[
    {state:"LOCATE", focus:"找到 src/auth.ts 中的 login 函数"},
    {state:"MODIFY", focus:"修复空指针异常"},
    {state:"VERIFY", focus:"运行 npm test 确认通过"}
  ]
```

闲聊直接路由到 ANSWER 状态，不执行任何代码操作：

```
用户: "你好"
REASON 输出:
  steps=[{state:"ANSWER", focus:"respond to greeting"}]
```

如果模型无法规划出有效步骤，任务直接结束（不 fallback 到代码修改流程）。

---

## 状态列表

| 状态 | 开放工具 | 用途 |
|------|---------|------|
| REASON | complete | 动态规划执行步骤 |
| LOCATE | read, grep, find, ls, ast_locator, complete | 定位需要修改的代码 |
| MODIFY | read, edit, write, complete | 应用代码修改 |
| VERIFY | read, bash, complete | 验证修改（运行测试/构建） |
| ANSWER | complete | 纯问答，不读文件 |
| RESEARCH | read, grep, webfetch, websearch, complete | 调研/解释/报告 |
| DIAGNOSE | read, grep, bash, complete | 调查 bug 根因 |
| REVIEW | read, grep, complete | 代码质量审查 |
| RUN | bash, complete | 执行命令 |
| SETUP | read, write, complete | 项目初始化 |

状态机根据模型规模动态调整约束：

```typescript
// 7B 小模型
{ maxFilesPerTask: 2, maxRetries: 1, strictPlanning: true }
// 30B 中模型
{ maxFilesPerTask: 4, maxRetries: 2, strictPlanning: true }
// 70B+ 大模型
{ maxFilesPerTask: 8, maxRetries: 3, strictPlanning: false }
```

---

## 环境要求

- Node.js 20+
- [Ollama](https://ollama.ai)（本地模型运行时）或 OpenAI 兼容 API

## 安装

```bash
npm install
```

## 初始化

```bash
npx tsx src/cli.ts setup
```

交互式向导引导完成模型配置、LSP 安装和代码图构建。

## 使用

### TUI 交互模式（推荐）

```bash
npx tsx src/cli.ts tui
```

| 快捷键 | 功能 |
|--------|------|
| `Enter` | 执行任务 |
| `Esc` | 中断当前执行 |
| `Tab` | 展开/折叠思考过程 |
| `d` | 切换调试模式 |
| `Ctrl+C` | 退出 |

### CLI 单次执行

```bash
npx tsx src/cli.ts run "修复 src/auth.ts 中的登录 bug"
```

### 配置

```bash
npx tsx src/cli.ts config          # 查看当前配置（含 LSP 状态）
npx tsx src/cli.ts config -m qwen3.5:9b -p ollama
```

---

## 项目结构

```
src/
├── cli.ts                    # CLI 入口（run/tui/config/setup）
├── config/                   # 配置加载/保存，LSP 状态检测
├── core/
│   ├── agent/                # ReactAgent（index/builder/step-runner/types）
│   ├── cognitive/            # StagnationDetector
│   ├── compaction/           # ContextCompactor（Token 预算压缩）
│   ├── failure/              # FailureHandler（四层降级）
│   ├── graph/                # BM25 + Call Graph 代码定位（SQLite）
│   ├── prompts/              # 各状态的 system prompt
│   ├── session.ts            # StateMachineAgent（工具白名单 + 状态管理）
│   └── states.ts             # 状态配置，模型规模检测
├── provider/
│   ├── llm.ts                # LLMConnector
│   └── model-info.ts         # 动态获取上下文长度
├── tool/
│   ├── complete.ts           # complete() 工具（各状态 schema）
│   ├── locator.ts            # AST 定位工具
│   ├── lsp.ts                # LSP 诊断客户端
│   └── safety/               # Checkpoint、行数限制
└── tui/
    ├── app.ts                # 主 TUI（ESC 中断、调试模式）
    └── setup.ts              # 交互式初始化向导
```

## 开发

```bash
npx vitest run                # 运行所有测试
npx tsc --noEmit              # 类型检查
```

真实 Ollama 集成测试（需要 Ollama 运行且模型已加载）：

```bash
npx vitest run tests/e2e/ollama-real.test.ts
```

## 技术栈

| 依赖 | 用途 |
|------|------|
| `@mariozechner/pi-agent-core` | Agent 核心（工具系统、ReAct 循环） |
| `@mariozechner/pi-ai` | LLM 调用层（openai-completions 兼容） |
| `@mariozechner/pi-coding-agent` | 编码工具（read/bash/edit/write） |
| `@mariozechner/pi-tui` | 终端 UI 组件库 |
| `better-sqlite3` | 代码图持久化（BM25 + Call Graph） |
| `commander` | CLI 框架 |
| `vitest` | 测试框架 |
