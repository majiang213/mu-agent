# 场景 6: Java Bug 修复 — NullPointerException

## 项目描述
一个简单的 Java 订单服务，包含订单合计、折扣计算、最贵商品查找等功能。
`OrderService.java` 有一个明显的 NPE 风险，测试会暴露它。

## 前置条件
需要 Java 17+ 和 Maven：
```bash
java -version   # 要求 17+
mvn -version
```

## 运行测试（先确认失败）
```bash
cd tests/fixtures/fixture-java
mvn test
```
预期失败：`calculateDiscount_nullCoupon_shouldNotThrow` — 传入 `null` coupon 时 `couponCode.equals(...)` 抛 NPE。

## 测试方法
进入此目录后，启动 Agent TUI（从项目根目录）：
```bash
npx tsx ../../../src/cli.ts tui
```

### 推荐测试输入

**用测试报错驱动（最真实）：**
```
mvn test 跑不过，帮我修复
```

**指向具体问题：**
```
OrderService.java 里的 calculateDiscount 方法在 couponCode 为 null 时会抛 NullPointerException，帮我修复
```

**让 Agent 自己发现（最难）：**
```
帮我审查 OrderService.java，找出潜在的运行时异常风险
```

## 错误位置
`OrderService.java` 第 16 行：
```java
if (couponCode.equals("SAVE10")) {  // couponCode 为 null 时爆炸
```

**正确修法**（任意一种都算对）：
```java
if ("SAVE10".equals(couponCode)) { ... }
// 或
if (couponCode != null && couponCode.equals("SAVE10")) { ... }
// 或用 Objects.equals
```

## 期望 Agent 行为
- 状态链：REASON → LOCATE → MODIFY → VERIFY
- LOCATE：读 `OrderServiceTest.java` 了解哪个测试失败，定位到 `calculateDiscount`
- MODIFY：修改 `equals` 调用顺序或加 null 判断，**只改这一处**
- VERIFY：运行 `mvn test` 确认 6 条测试全部通过

## 判断标准
| 行为 | 好 | 差 |
|------|----|----|
| 定位精准 | 直接找到 `calculateDiscount` 第 16 行 | 乱改 `calculateTotal` |
| 修改最小 | 只改 equals 调用方式 | 重构整个方法 |
| 不引入新 bug | null 时返回 0（正确行为） | 把 null 情况直接 throw |
| 验证 | `mvn test` 全绿 | 不跑测试 |
