# µagent

> [English](./README.md) | 简体中文

基于 [pi](https://github.com/earendil-works/pi) 框架的本地 ReAct Coding Agent，专为 7B/8B 小模型设计。

让本地小模型也能可靠地完成真实编程任务——不依赖 GPT，不需要 API Key，完全在你的机器上运行。

---

## 100% 本地 —— 你的代码绝不离开你的机器

µagent **设计上完全本地**。它只与你自己配置的 LLM provider 通信 ——
[Ollama](https://ollama.com)、Unsloth Studio 或你自己的 OpenAI 兼容端点。**不调用任何第三方
API**，无硬编码云后端：

- 不调用 OpenAI / Anthropic / Google API。无需 API Key。
- 你的源码、prompt、文件内容只发送给**你自己的**本地模型 —— 绝不发送到你无法控制的远程服务器。
- 无遥测、无分析、无上报。除指向本地 URL 的 LLM 客户端外，无任何网络代码。

这是核心隐私保证：一个读写你私有代码库的 coding agent，在结构上就无法外泄它。在专有、离线或气隔仓库上运行，与本地脚本同等可信。

### 额外的 harness 级护栏

除纯本地网络外，agent 还有无法被 prompt 指令绕过的硬边界：

- **按状态工具白名单** — 每个状态只暴露其需要的 2–4 个工具；`complete()` 是唯一退出信号，按 schema 校验。
- **SafeModifier 检查点** — 每次 `edit`/`write` 先建检查点；若改动破坏语法/结构，post-check 自动回滚。项目根目录外的路径遍历被阻断；每任务文件/行数限制约束影响范围。
- **GIT 硬白名单（default-deny）** — git 命令经 harness guard，拒绝 shell 元字符和非 `git` 首 token，仅允许安全子命令。force-push、`reset --hard`、`rebase`、`commit --amend`、`filter-branch`、`branch -D`、`commit --no-verify` 及所有未列入子命令在**到达 shell 前**被阻断。

完整威胁模型与私密漏洞上报见 [SECURITY.md](./SECURITY.md)。

---

## 为什么小模型需要专项设计

把为大模型设计的 Agent 框架直接套到 7B/8B 小模型上，成功率会大幅下降。根源不在模型"笨"，而在任务的呈现方式不适合它。

µagent 的出发点：**不是让小模型变得更强，而是让任务变得更适合小模型**。

| 痛点 | 大模型（GPT、Claude） | 小模型（7B/8B） | µagent 的解法 |
|------|----------------------|----------------|-------------------|
| **上下文窗口** | 128K–1M token，长任务游刃有余 | 8K–32K token，几轮工具调用就满了 | 每个步骤独立启动全新 Agent，只携带本步骤上下文，步骤间只传递结构化摘要而非完整消息历史 |
| **错误恢复** | 遇到失败能分析原因、换策略重试 | 反复尝试同一种失败方法，无法自救 | 实时监控工具调用序列，检测到重复或无进展时先发警告提示换思路，二次触发则强制终止当前步骤 |
| **工具调用** | 自主选择工具准确，格式鲜有错误 | 经常选错工具，参数格式频繁不符合要求 | 每个状态只向 LLM 暴露 2–4 个必要工具，退出步骤的唯一方式是调用 `complete()` 并通过 schema 校验 |
| **代码定位** | 能在大上下文里阅读全局，推断目标文件 | 上下文装不下整个项目，靠猜文件名 | 用 TypeScript AST 预建函数调用图索引，BM25 召回 + 2-hop 图扩展，精确文件路径和行号直接写进 prompt |
| **任务规划** | 能一次性制定高质量多步骤计划 | 单次规划质量低，容易遗漏关键步骤 | 并行生成 N 份独立执行计划，再由 Synthesizer 审议综合各方案优点，输出比任何单次生成都更优的最终计划 |

---

## 快速上手

### 环境要求

- Node.js 24+
- [Ollama](https://ollama.com)、[Unsloth Studio](https://unsloth.ai)（本地模型运行时）或 OpenAI 兼容 API

### 安装

```bash
npm install -g @majiang213/mu-agent
```

> npm 包可能尚未发布。若 `npm install` 报 404，从源码安装：
>
> ```bash
> git clone https://github.com/majiang213/mu-agent.git
> cd mu-agent
> pnpm install
> pnpm build
> npm link   # 全局可用 mu-agent 命令
> ```

### 初始化

```bash
mu-agent setup
```

交互式向导引导完成模型配置、LSP 安装和代码图构建。

### 使用

**TUI 交互模式（推荐）**

```bash
mu-agent tui

# 恢复上次会话
mu-agent tui -c

# 交互式选择历史会话
mu-agent tui --resume
```

| 快捷键 | 功能 |
|--------|------|
| `Enter` | 执行任务 |
| `Esc` | 中断当前执行 |
| `Ctrl+T` | 展开/折叠思考块 |
| `Ctrl+O` | 展开/折叠工具块 |
| `Ctrl+D` | 切换调试模式 |
| `Ctrl+C` | 退出 |

**CLI 单次执行**

```bash
mu-agent run "修复 src/auth.ts 中的登录 bug"
```

**查看和修改配置**

```bash
mu-agent config                      # 查看当前配置（含 LSP 状态）
mu-agent config -m gemma4:e4b        # 切换模型
```

---

## 运行机制

### 整体架构

每次执行任务，ReactAgent 先让 REASON Agent 制定步骤列表，再按顺序启动独立的 Step Agent 依次执行。每个 Agent 实例完全隔离，只携带该状态允许的工具。

```
用户输入
  │
  ▼
ReactAgent.run()
  │
  ├── 1. REASON Agent（规划）
  │      Heavy Thinking：并行采样 N 个方案 → Synthesizer 审议 → 最优 steps[]
  │      输出: steps[] = [{state, focus}, ...]
  │
  ├── 2. Step-1 Agent（如 LOCATE）
  │      tools: 按状态白名单
  │      输出: ExecutedStep（含结构化 output）
  │
  └── 3. Step-N Agent（如 MODIFY → VERIFY）
         输入: 原始任务 + 前序 ExecutedStep 摘要
         输出: ExecutedStep
```

### 动态任务规划

REASON Agent 分析输入，输出要执行哪些步骤、每步做什么：

```
用户: "修复登录 bug"
REASON 输出:
  steps=[
    {state:"LOCATE", focus:"找到 src/auth.ts 中的 login 函数"},
    {state:"MODIFY", focus:"修复空指针异常"},
    {state:"VERIFY", focus:"运行 npm test 确认通过"}
  ]
```

闲聊直接路由到 ANSWER，不触发任何代码操作：

```
用户: "你好"
REASON 输出:
  steps=[{state:"ANSWER", focus:"respond to greeting"}]
```

若 REASON 判断无需额外操作（如任务已完成），返回空 steps，执行立即结束。

### Heavy Thinking

对 SMALL（≤9B）和 MEDIUM（≤30B）模型，REASON 阶段自动启用 Heavy Thinking，显著提升规划质量：

```
REASON 阶段（SMALL/MEDIUM 自动启用）
  │
  ├── 并行采样 N 个方案（各自独立 Agent，temperature=0.7）
  │     Plan A: [LOCATE → MODIFY → VERIFY]
  │     Plan B: [DIAGNOSE → LOCATE → MODIFY → VERIFY]
  │     Plan C: [LOCATE → MODIFY → VERIFY]
  │
  └── Synthesizer 审议
        综合 N 个方案的优点 → 输出新 steps[]
        Refinement 循环：Judge 评估（Jaccard > 0.85 或 SAME → 停止）
```

Synthesizer 不是从候选中挑一个，而是主动综合各方案优点，在所有方案都有缺陷时能从零重推。

---

## 状态参考

### 状态列表

| 状态 | 开放工具 | 用途 |
|------|---------|------|
| REASON | complete | 动态规划执行步骤（含 Heavy Thinking），必要时开放 memory_search |
| CLARIFY | complete | 向用户提问澄清任务意图 |
| LOCATE | read, ast_code_locator, complete | 精确定位需要修改的代码 |
| MODIFY | read, edit, write, complete | 应用代码修改 |
| VERIFY | read, bash, complete | 验证修改（运行测试/构建） |
| DIAGNOSE | read, grep, bash, complete | 调查 bug 根因 |
| ANSWER | complete | 纯问答，不读文件 |
| RESEARCH | read, grep, find, ls, webfetch, websearch, complete | 调研/解释/报告 |
| REVIEW | read, grep, complete | 代码质量审查 |
| TEST_WRITE | read, edit, write, complete | 编写测试用例 |
| REFACTOR_PLAN | read, complete | 规划重构方案 |
| ROLLBACK | read, write, bash, edit, complete | 回滚错误修改 |
| SETUP | read, bash, write, complete | 项目初始化 |
| WRITE | read, write, complete | 创建新文件（README、配置等），不修改现有代码 |
| PLAN | bash, read, complete | 两级规划子规划器：分析现状后产出子步骤列表（只读，不执行修改） |
| GIT | bash, read, complete | git 操作专用状态：commit/branch/merge/push 等，harness 层硬拦截危险命令 |
| DONE | — | 终态，任务结束 |

### 模型规模自动适配

tier 由 Ollama API `general.parameter_count` 字段自动判断（custom / unsloth provider 通过 `modelSize` 配置手动指定，默认 LARGE）：

```
SMALL  (≤9B)   → maxFilesPerTask=2, maxRetries=1, strictPlanning=true,  Heavy Thinking planCount=3
MEDIUM (≤30B)  → maxFilesPerTask=4, maxRetries=2, strictPlanning=true,  Heavy Thinking planCount=2
LARGE  (>30B)  → maxFilesPerTask=8, maxRetries=3, strictPlanning=false, Heavy Thinking 禁用
```

### VERIFY 失败自动重试

VERIFY 返回 `passed=false` 时，系统携带失败上下文重新规划，而非直接报错：

```
VERIFY failed
  → 携带失败上下文重新 REASON → 新 steps[]（通常含 ROLLBACK 或 DIAGNOSE）
  → 最多重试 2 次
  → 仍失败则返回 success: false
```

### 两级规划（subplan）

某些任务的步骤数/目标在执行前无法确定（如：拆分 git commit、修复所有失败测试、批量替换 API）。REASON 规划时输出 `{subplan:{analyzerState:"PLAN", focus:"<分析什么，产出什么计划>"}}`，由 `State.PLAN`（只读子规划器，bash+read）运行后产出子步骤列表，harness 递归展开执行：

```
REASON → [{subplan:PLAN, focus:"分析 git 改动，规划原子提交"}]
  → PLAN step（bash/read 分析）→ complete(steps=[GIT, GIT, ...])
  → harness 展开执行子步骤
```

- `analyzerState` 强制为 `PLAN`（防伪造其他 state 绕过 guard）
- PLAN 输出的子步骤不再嵌套 subplan（防无限递归）
- PLAN 输出不可解析时标记 step 失败（`{failed:true,...}`），不静默报成功
- subplan 语义贯穿 Heavy Thinking 采样/审议链路，多方案的 subplan 可被 Synthesizer 合并

### GIT 状态与 harness git guard

git 操作走专用 `State.GIT` 状态（bash+read+complete），避免借用 MODIFY/VERIFY 的 bash 造成语义错位。REASON 路由：查看 git 历史/diff → `[GIT]`，提交改动 → `[GIT]`，修完代码再提交 → `[..., MODIFY, VERIFY, GIT]`。

**harness 层硬白名单（default-deny，不可被 instruction 绕过）**：bash 执行前由 `wrapWithGitGuard()` 检查，仅允许明确安全的 git 子命令（read-ops / add / 安全 commit / branch -d / checkout / stash push/pop/apply / tag / fetch / cherry-pick / revert / merge / push 到非默认分支），其余一律拒绝。具体拒绝：
- shell 元字符（`&`/`;`/`|`/换行/`$`/backtick/`()` 等）— 防 chaining/命令替换绕过
- 非 `git` 首 token（`/usr/bin/git`、`bash -c`、`sudo git`）
- force-push（`--force`/`-f`/`--force-with-lease`/`+refspec`）、`push to main/master/HEAD`、`--mirror`/`--all`/`--delete` refspec
- 历史重写：`reset --hard`、`rebase`、`commit --amend`、`filter-branch`、`replace`、`fast-import`、`update-ref`、`symbolic-ref`
- `clean -f`、`stash drop/clear`、`branch -D`、`commit --no-verify/-n`、`reflog expire`、`config alias.*` 写入

- merge 产生冲突 → `git merge --abort` 后 `complete(operation="merge", conflicts=[...])` 报告（harness 无冲突 re-REASON 路径，故要求 abort 后报告）
- push 仅允许非默认分支，永远不 push 到 main/master
- guard 在所有暴露 bash 的 state 都生效（非仅 GIT），防误路由绕过

---

## 项目结构

```
src/
├── cli.ts                    # CLI 入口（run / tui / config / setup）
├── config/                   # 配置加载/保存，LSP 状态检测
├── core/
│   ├── agent/                # ReactAgent（index / builder / step-runner / context / types）
│   ├── session/              # StateMachineAgent + SessionStore（JSONL 持久化）
│   ├── heavy/                # Heavy Thinking：并行采样 + Synthesizer 审议 + Refinement B/C
│   ├── memory/               # MemoryStore 三层记忆系统（episodes + semantic_facts + 锚点注入）
│   ├── cognitive/            # StagnationDetector（停滞检测）
│   ├── compaction/           # ContextCompactor（Token 预算压缩）
│   ├── failure/              # FailureHandler（重试 + 升级）
│   ├── graph/                # BM25 + Call Graph 代码定位（SQLite）
│   ├── prompts/              # 各状态的 system prompt
│   ├── states.ts             # 状态配置，tier 由参数量决定
│   └── types.ts              # State 枚举、Step、ExecutedStep、StepDirective 等核心类型
├── provider/
│   └── model-info.ts         # 动态获取上下文长度 + 模型参数量（ollama / custom / unsloth）
├── tool/
│   ├── complete.ts           # complete() 工具（从 STATE_REGISTRY 读取 schema）
│   ├── locator.ts            # AST 定位工具
│   ├── lsp.ts                # LSP 诊断客户端（edit/write 后自动注入诊断）
│   ├── memory-search.ts      # memory_search 工具（Gap 42）
│   ├── webfetch.ts
│   ├── websearch.ts
│   └── safety/               # Checkpoint、行数限制、语法检查
└── tui/
    ├── app.ts                # 主 TUI（17 states、ESC 中断、调试模式、会话持久化）
    ├── metrics.ts            # MetricsCollector（token/耗时统计）
    ├── setup.ts              # 交互式初始化向导（4步）
    └── theme.ts              # 颜色主题（17个状态各自颜色）
```

## 开发

```bash
pnpm test            # 运行所有测试（vitest）
pnpm build           # 编译 TypeScript（tsc）
# 仅类型检查（不产出）：npx tsc --noEmit
```

真实 Ollama 集成测试（需要 Ollama 运行且模型已加载）：

```bash
npx vitest run tests/e2e/ollama-real.test.ts
```

## 技术栈

| 依赖 | 用途 |
|------|------|
| `@earendil-works/pi-agent-core` | Agent 核心（工具系统、ReAct 循环） |
| `@earendil-works/pi-ai` | LLM 调用层（openai-completions 兼容） |
| `@earendil-works/pi-coding-agent` | 编码工具（read / bash / edit / write） |
| `@earendil-works/pi-tui` | 终端 UI 组件库 |
| `better-sqlite3` | 代码图持久化（BM25 + Call Graph）+ MemoryStore（episodic memory） |
| `commander` | CLI 框架 |
| `vitest` | 测试框架 |

---

## 设计灵感

- **[Agentless（ICSE 2025）](https://github.com/OpenAutoCoder/Agentless)**：确定性管道比 LLM 自主规划成功率高 40%+，把复杂任务拆成受约束的子任务，每个子任务固定工具集 + 专属 prompt。
- **Agentless SWE-bench**：精确代码定位是编程 Agent 的瓶颈，BM25 召回 + Call Graph 扩展，零 LLM 调用精确到函数行号。
- **Heavy Thinking**：并行采样 + Synthesizer 审议的灵感来自 [Large Language Monkeys](https://arxiv.org/abs/2407.21787) 和 [Self-consistency](https://arxiv.org/abs/2203.11171)。
