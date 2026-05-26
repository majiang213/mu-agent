# 场景 4: TypeScript 类型错误修复

## 项目描述
一个 TypeScript 项目，定义了 `User` / `Post` / `ApiResponse` 类型，以及若干 API 工具函数。
`tsc --noEmit` 目前报 **3 个类型错误**。

## 确认错误（先自己 tsc 一下）
```bash
npx tsc --noEmit
```
预期输出：
```
api.ts(10,12): error TS2322: ... role: string is not assignable to "user"|"admin"|"guest"
api.ts(20,5):  error TS2322: ... 'string' is not assignable to type 'Date'
api.ts(40,5):  error TS2322: ... 'string' is not assignable to type 'Date'
```

## 测试方法
1. 进入此目录：`cd tests/fixtures/fixture-ts-types`
2. 启动 Agent TUI（从项目根目录）：
   ```
   npx tsx ../../../src/cli.ts tui
   ```

### 推荐测试输入

**用命令驱动：**
```
api.ts 有 TypeScript 类型错误，帮我修复，修复后 tsc --noEmit 应该零错误
```

**完全不提示：**
```
这个项目的类型检查过不了，帮我修
```

## 错误说明（不要提前告诉 Agent）

| 位置 | 错误 | 正确写法 |
|------|------|---------|
| `getUser` 里 `role: 'superadmin'` | `'superadmin'` 不在联合类型里 | 改成 `'admin'` 或 `'user'` |
| `createPost` 里 `publishedAt: 'not-a-date'` | 字符串不是 `Date \| null` | 改成 `null` 或 `new Date()` |
| `publishPost` 里 `publishedAt: new Date().toISOString()` | `toISOString()` 返回 string，不是 Date | 改成 `new Date()` |

## 期望 Agent 行为
- 状态链：REASON → LOCATE → MODIFY → VERIFY
- LOCATE：运行 `tsc --noEmit` 或直接读 api.ts 找到错误行
- MODIFY：最小化修改，只改类型不对的地方
- VERIFY：再次运行 `tsc --noEmit` 确认零错误

## 判断标准
| 行为 | 好 | 差 |
|------|----|----|
| 用 tsc 诊断 | 先跑 tsc 找错误 | 猜错误在哪 |
| 修改精准 | 只改 3 处错误行 | 重写整个文件 |
| 不乱改逻辑 | role 改成有效枚举值 | 把 role 字段删掉 |
| 验证 | tsc 零错误才结束 | 改完就说"完成" |
