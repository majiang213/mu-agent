# Agent 对话测试 — 操作手册

## 前置条件

| 依赖 | 用途 | 安装 |
|------|------|------|
| Node.js 20+ | 运行 Agent | — |
| Ollama | 本地模型运行时 | https://ollama.ai |
| 目标模型已拉取 | 实际推理 | `ollama pull qwen2.5-coder:7b` |
| Java 17+ Maven | fixture-java | `brew install openjdk maven` |
| Python 3.10+ pytest | fixture-python-fix / fixture-readme | `pip install pytest` |

启动前确认 Ollama 正在运行：
```bash
ollama list          # 查看已有模型
ollama run qwen2.5-coder:7b   # 手动测试模型是否正常
```

---

## 快速开始

**第一次使用**，先完成 Agent 初始化：
```bash
# 从项目根目录
npx tsx src/cli.ts setup
```

**启动方式**（始终从项目根目录运行，cd 到 fixture 目录只是为了让 Agent 看到正确的文件上下文）：
```bash
# 1. 进入目标场景目录
cd tests/fixtures/<fixture-name>

# 2. 启动 TUI（路径相对于 fixture 目录）
npx tsx ../../../src/cli.ts tui
```

---

## 场景一览

| # | 目录 | 语言 | 场景类型 | 期望状态链 | 难度 |
|---|------|------|---------|-----------|------|
| 1 | `fixture-calc` | JavaScript | Bug 修复（除零） | REASON → LOCATE → MODIFY → VERIFY | ⭐ |
| 2 | `fixture-todo-api` | JavaScript | 功能添加（缺 DELETE） | REASON → LOCATE → MODIFY → VERIFY | ⭐⭐ |
| 3 | `fixture-auth` | JavaScript | 代码审查（安全漏洞） | REASON → REVIEW → ANSWER | ⭐⭐ |
| 4 | `fixture-ts-types` | TypeScript | 类型错误修复 | REASON → LOCATE → MODIFY → VERIFY | ⭐⭐⭐ |
| 5 | `fixture-readme` | Python | 纯问答（理解项目） | REASON → ANSWER | ⭐ |
| 6 | `fixture-java` | Java | Bug 修复（NPE） | REASON → LOCATE → MODIFY → VERIFY | ⭐⭐ |
| 7 | `fixture-python-fix` | Python | Bug 修复（排序逻辑） | REASON → LOCATE → MODIFY → VERIFY | ⭐⭐ |

---

## 各场景操作步骤

---

### 场景 1 — fixture-calc（JavaScript）

**场景**：`divide(10, 0)` 返回 `Infinity`，`average([])` 返回 `NaN`，应该抛出错误。

```bash
cd tests/fixtures/fixture-calc
npx tsx ../../../src/cli.ts tui
```

| 难度 | 输入 |
|------|------|
| 简单 | `divide 函数在除数为 0 时应该抛出错误，帮我修复` |
| 中等 | `calc.js 里的测试跑不过，帮我修复` |
| 困难 | `帮我检查 calc.js 有没有问题` |

**验收**：Agent 修完后 `npm test` 全绿（需先 `npm install`）。

---

### 场景 2 — fixture-todo-api（JavaScript）

**场景**：Express TODO API 缺少 `DELETE /todos/:id` 路由，测试文件里有对应用例。

```bash
cd tests/fixtures/fixture-todo-api
npm install      # 首次需要安装依赖
npx tsx ../../../src/cli.ts tui
```

| 难度 | 输入 |
|------|------|
| 简单 | `给 server.js 加上 DELETE /todos/:id 接口，id 不存在返回 404` |
| 中等 | `server.test.js 里有 DELETE 的测试跑不过，帮我实现对应接口` |
| 困难 | `这个 TODO API 功能不完整，帮我补全` |

**验收**：`npm test` 5 条测试全绿。

---

### 场景 3 — fixture-auth（JavaScript）

**场景**：JWT 认证模块有 4 个安全问题（hardcoded secret、无过期时间、MD5 密码哈希、id 冲突），测试 Agent 能发现几个。

```bash
cd tests/fixtures/fixture-auth
npx tsx ../../../src/cli.ts tui
```

| 难度 | 输入 |
|------|------|
| 简单 | `帮我审查 auth.js，找出所有安全问题` |
| 中等 | `auth.js 里的 JWT 实现有什么安全隐患` |
| 困难（要求修复） | `审查 auth.js 的安全性，并修复所有高危问题` |

**验收标准**：

| 问题 | 发现 = 合格 | 发现 = 优秀 |
|------|------------|------------|
| Hardcoded secret | ✅ 必须 | — |
| Token 无过期 | ✅ 必须 | — |
| MD5 密码哈希 | — | ✅ 加分 |
| id 冲突风险 | — | ✅ 加分 |

---

### 场景 4 — fixture-ts-types（TypeScript）

**场景**：`api.ts` 有 3 个 TypeScript 类型错误，`tsc --noEmit` 会报出来。

```bash
cd tests/fixtures/fixture-ts-types
npx tsx ../../../src/cli.ts tui
```

先手动确认错误存在：
```bash
npx tsc --noEmit
# 应该报 3 个 TS2322 错误
```

| 难度 | 输入 |
|------|------|
| 简单 | `api.ts 有 TypeScript 类型错误，帮我修复，修复后 tsc --noEmit 应该零错误` |
| 困难 | `这个项目的类型检查过不了，帮我修` |

**验收**：Agent 修完后 `npx tsc --noEmit` 零错误。

---

### 场景 5 — fixture-readme（Python）

**场景**：纯问答，测试 Agent **不修改文件**、正确理解并解释 Python 爬虫代码。

```bash
cd tests/fixtures/fixture-readme
npx tsx ../../../src/cli.ts tui
```

| 测试目标 | 输入 |
|---------|------|
| 项目理解 | `这个项目是干什么的？帮我解释一下` |
| API 理解 | `crawler.py 里的 crawl 函数怎么用？给我一个使用示例` |
| 跨文件理解 | `stats.py 和 crawler.py 是怎么配合使用的` |
| 问题分析 | `这个爬虫有什么潜在问题或改进空间` |

**验收**：
- ✅ Agent 没有修改任何文件
- ✅ 没有进入 LOCATE/MODIFY/VERIFY 状态
- ✅ 给出了准确的函数解释和调用示例

---

### 场景 6 — fixture-java（Java）

**场景**：`calculateDiscount(items, null)` 时 `couponCode.equals(...)` 抛 NPE，测试会暴露。

```bash
cd tests/fixtures/fixture-java
mvn test          # 确认有测试失败
npx tsx ../../../src/cli.ts tui
```

| 难度 | 输入 |
|------|------|
| 简单 | `mvn test 跑不过，帮我修复` |
| 中等 | `OrderService.java 的 calculateDiscount 在 couponCode 为 null 时会抛 NPE，帮我修` |
| 困难 | `帮我 review OrderService.java，找出潜在的运行时异常风险` |

**验收**：`mvn test` 6 条测试全绿。

---

### 场景 7 — fixture-python-fix（Python）

**场景**：`top_n_by` 用字符串排序而不是数值排序，导致 `"95" < "9"` 这类字典序错误。

```bash
cd tests/fixtures/fixture-python-fix
pytest -v         # 确认 test_top_n_by_numeric 失败
npx tsx ../../../src/cli.ts tui
```

| 难度 | 输入 |
|------|------|
| 简单 | `pytest 有一条测试跑不过，帮我修` |
| 中等 | `top_n_by 函数排序结果不对，应该按数值排序而不是字符串排序` |
| 困难 | `帮我 review data_processor.py，找出有没有逻辑 bug` |

**验收**：`pytest -v` 7 条测试全绿。

---

## TUI 操作说明

| 按键 | 功能 |
|------|------|
| `Enter` | 发送消息 / 执行任务 |
| `Esc` | 中断当前 Agent 执行 |
| `Tab` | 展开 / 折叠思考过程 |
| `d` | 切换调试模式（显示状态跳转详情） |
| `Ctrl+C` | 退出 TUI |

调试模式（`d` 键）下可以看到：
- 当前执行的 State（REASON / LOCATE / MODIFY / VERIFY / ANSWER …）
- 每次工具调用的参数和结果
- 状态跳转链路

---

## 观测重点

测试时重点关注这几个行为：

### 1. REASON 状态路由是否准确
- 问答类任务 → 应该路由到 `ANSWER`，**不应该**进入 `LOCATE/MODIFY`
- 修复类任务 → 应该路由到 `LOCATE → MODIFY → VERIFY`

### 2. LOCATE 定位是否精准
- 能否直接读到正确文件，而不是乱读
- 能否通过测试文件反向定位问题函数

### 3. MODIFY 修改是否最小化
- 只改有问题的那几行
- 不重构无关代码

### 4. VERIFY 是否主动验证
- 修完后是否自动运行测试（`npm test` / `mvn test` / `pytest` / `tsc --noEmit`）
- 测试失败时是否重新修复而不是直接结束

### 5. 闲聊/问答是否不动文件
- 场景 5 的问答任务，Agent 全程不应该写任何文件

---

## 常见问题

**Q: Agent 说"我无法运行测试"**
- 检查是否在 fixture 目录下启动了 TUI，依赖是否已安装

**Q: 模型一直重复同样的工具调用**
- 触发了 stagnation detection，等待 Agent 自动升级重试策略；或按 `Esc` 中断后重新描述任务

**Q: steps=[] Agent 直接结束了**
- REASON 认为任务不需要代码操作。尝试更明确的指令，例如加上"运行测试确认"

**Q: Java / Python 场景 Agent 找不到文件**
- 确认当前工作目录是 fixture 子目录，不是项目根目录
