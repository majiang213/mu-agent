# 场景 7: Python Bug 修复 — 数据处理逻辑错误

## 项目描述
一个 Python CSV 数据处理模块，支持加载、过滤、分组、排序和合并 records。
有 **1 个隐性 bug**：`top_n_by` 用字符串排序而不是数值排序，导致 `"95" < "9"` 这类问题。

## 前置条件
需要 Python 3.10+ 和 pytest：
```bash
python3 --version    # 要求 3.10+
pip install pytest
```

## 运行测试（先确认失败）
```bash
cd tests/fixtures/fixture-python-fix
pytest -v
```
预期 `test_top_n_by_numeric` 失败：字符串排序下 `"95"` 排不到第一位。

## 测试方法
进入此目录后，启动 Agent TUI（从项目根目录）：
```bash
npx tsx ../../../src/cli.ts tui
```

### 推荐测试输入

**用测试失败驱动：**
```
pytest 有一条测试跑不过，帮我修
```

**指向具体函数：**
```
data_processor.py 里的 top_n_by 函数排序结果不对，应该按数值排序而不是字符串排序
```

**让 Agent 发现（较难）：**
```
帮我 review data_processor.py，找出有没有逻辑 bug
```

## 错误位置
`data_processor.py` 第 35 行：
```python
return sorted(records, key=lambda r: r[column], reverse=True)[:n]
#                                     ^^^^^^^^^^
#                       r[column] 是字符串，"9" > "88" > "78" (字典序)
```

**正确修法**：
```python
return sorted(records, key=lambda r: float(r[column]), reverse=True)[:n]
```

## 期望 Agent 行为
- 状态链：REASON → LOCATE → MODIFY → VERIFY
- LOCATE：读测试文件找失败用例，读 `top_n_by` 函数定位问题
- MODIFY：把 `key=lambda r: r[column]` 改为 `key=lambda r: float(r[column])`
- VERIFY：运行 `pytest -v` 确认 7 条测试全部通过

## 判断标准
| 行为 | 好 | 差 |
|------|----|----|
| 理解根因 | 字符串 vs 数值排序问题 | 只说"排序有问题"没有说原因 |
| 修改最小 | 只改 `key=` lambda 一处 | 重写整个函数 |
| 不破坏其他 | 只改 top_n_by | 乱动 filter_above 等函数 |
| 验证 | pytest 全绿 | 不跑测试 |
