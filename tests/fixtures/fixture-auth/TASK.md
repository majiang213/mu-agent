# 场景 3: 代码审查 — JWT 安全问题

## 项目描述
一个 Node.js 认证模块，处理用户登录和 JWT token 签发。

## 隐藏的安全问题（共 4 处，不要提前告诉 Agent）
1. `SECRET = 'supersecret123'` — hardcoded secret，应从环境变量读取
2. `jwt.sign(...)` 没有设置 `expiresIn`，token 永不过期
3. `hashPassword` 用 MD5，MD5 不适合密码哈希，应用 bcrypt
4. `createUser` 中 `id: db.length + 1` 在并发删除后会产生 id 冲突

## 测试方法
1. 进入此目录：`cd tests/fixtures/fixture-auth`
2. 启动 Agent TUI（从项目根目录）：
   ```
   npx tsx ../../../src/cli.ts tui
   ```

### 推荐测试输入

**代码审查（考验 REVIEW 状态）：**
```
帮我审查 auth.js，找出所有安全问题
```

**更具体的问法：**
```
auth.js 里的 JWT 实现有什么安全隐患？
```

**要求修复（考验 REVIEW → MODIFY 链）：**
```
审查 auth.js 的安全性，并修复所有高危问题
```

## 期望 Agent 行为

### 纯审查模式
- 状态链：REASON → REVIEW（或 RESEARCH）→ ANSWER
- 输出：列出安全问题清单，给出修复建议

### 审查+修复模式
- 状态链：REASON → REVIEW → MODIFY → VERIFY
- 至少修复：hardcoded secret + token 无过期时间

## 判断标准
| 问题 | Agent 发现了 | Agent 没发现 |
|------|-------------|-------------|
| Hardcoded secret | ✅ | ❌ |
| Token 无过期 | ✅ | ❌ |
| MD5 密码哈希 | ✅ | ❌ (可以接受) |
| id 冲突 | ✅ | ❌ (加分项) |

发现前两个就算合格，发现全部算优秀。
