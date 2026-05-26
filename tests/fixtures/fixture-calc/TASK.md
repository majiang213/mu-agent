# 场景 1: Bug 修复 — 除零处理

## 项目描述
一个简单的 JavaScript 计算器模块。

## 已知问题
- `divide(10, 0)` 返回 `Infinity` 而不是抛出错误
- `average([])` 对空数组除以 0，返回 `NaN`

## 测试方法
1. 进入此目录：`cd tests/fixtures/fixture-calc`
2. 启动 Agent TUI（从项目根目录）：
   ```
   npx tsx ../../../src/cli.ts tui
   ```
3. 输入下面任意一条任务：

### 推荐测试输入

**基础修复：**
```
divide 函数在除数为 0 时应该抛出错误，现在它返回 Infinity，帮我修复
```

**稍难一点（需要 Agent 自己发现两个 bug）：**
```
calc.js 里的测试跑不过，帮我修复
```

**最难（完全不给提示）：**
```
帮我检查 calc.js 有没有问题
```

## 期望 Agent 行为
- 状态链：REASON → LOCATE → MODIFY → VERIFY
- LOCATE：读取 calc.js，定位 divide 和 average 函数
- MODIFY：在 divide 加 `if (b === 0) throw new Error(...)` 守卫
- VERIFY：运行 `npm test` 确认测试通过

## 判断标准
| 行为 | 好 | 差 |
|------|----|----|
| 找到正确文件 | 直接定位 calc.js | 乱读其他文件 |
| 修改精准 | 只改 divide/average | 改了 add/subtract |
| 验证 | 主动运行测试 | 修改完就结束 |
| 两个 bug 都找到 | 同时修 divide 和 average | 只修一个 |
