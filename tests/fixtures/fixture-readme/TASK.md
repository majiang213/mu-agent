# 场景 5: 纯问答 — 理解 Python 项目

## 项目描述
一个没有 README 的 Python 网页爬虫项目，包含两个模块：
- `crawler.py`：核心爬虫逻辑
- `stats.py`：爬取结果统计分析

## 测试方法
1. 进入此目录：`cd tests/fixtures/fixture-readme`
2. 启动 Agent TUI（从项目根目录）：
   ```
   npx tsx ../../../src/cli.ts tui
   ```

### 推荐测试输入（纯问答，不需要修改代码）

**理解项目：**
```
这个项目是干什么的？帮我解释一下
```

**深入功能：**
```
crawler.py 里的 crawl 函数怎么用？给我一个使用示例
```

**分析问题：**
```
这个爬虫有什么潜在问题或改进空间？
```

**跨文件理解：**
```
stats.py 和 crawler.py 是怎么配合使用的？
```

## 期望 Agent 行为
- 状态链：REASON → ANSWER 或 REASON → RESEARCH → ANSWER
- **不应该**修改任何文件
- **不应该**进入 LOCATE / MODIFY / VERIFY 状态
- 应该读取代码文件后给出清晰的解释

## 判断标准
这个场景主要测试 Agent **不乱动代码**的能力：

| 行为 | 好 | 差 |
|------|----|----|
| 状态路由 | REASON → ANSWER/RESEARCH | 进入了 LOCATE/MODIFY |
| 回答质量 | 准确解释 crawl 的参数和返回值 | 胡说一通 |
| 不动文件 | 只读，不写 | 莫名其妙创建了文件 |
| 给出示例 | 给出可运行的 Python 调用示例 | 只说"这是一个爬虫" |

## 参考答案（用于对比）
`crawl(start_url, max_pages=10, delay=0.5, same_domain=True)` 返回：
```python
{
    "pages_visited": int,        # 实际访问页数
    "top_words": [(word, count)], # 词频 Top 20
    "link_graph": {url: [links]}, # 页面链接图
    "errors": [str]              # 失败的 URL
}
```
