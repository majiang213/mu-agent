# 场景 2: 功能添加 — 缺失 DELETE 接口

## 项目描述
一个 Express TODO REST API，支持 GET / POST / PUT，但**缺少 DELETE 接口**。

## 缺失功能
`DELETE /todos/:id` 路由完全没有实现，测试跑会报 404。

## 测试方法
1. 进入此目录：`cd tests/fixtures/fixture-todo-api`
2. 启动 Agent TUI（从项目根目录）：
   ```
   npx tsx ../../../src/cli.ts tui
   ```
3. 输入下面任意一条任务：

### 推荐测试输入

**直接说需求：**
```
给 server.js 的 TODO API 加上 DELETE /todos/:id 接口，id 不存在时返回 404
```

**用测试驱动（更考验 Agent）：**
```
server.test.js 里有 DELETE 的测试跑不过，帮我实现对应的接口
```

**模糊需求：**
```
这个 TODO API 功能不完整，帮我补全
```

## 期望 Agent 行为
- 状态链：REASON → LOCATE → MODIFY → VERIFY
- LOCATE：读 server.js 找到路由定义位置，读 server.test.js 了解期望行为
- MODIFY：在 PUT 路由后面加 DELETE 路由，过滤 todos 数组
- VERIFY：运行 `npm test` 确认 5 条测试全部通过

## 判断标准
| 行为 | 好 | 差 |
|------|----|----|
| 读测试文件 | 先读 test 了解期望 | 直接猜实现 |
| 插入位置 | 在 PUT 路由之后 | 乱插到文件开头 |
| 404 处理 | 实现了 not found 判断 | 直接 splice 不判断 |
| 验证 | 运行测试验证 | 改完就结束 |
