#!/bin/bash
echo "=== 测试1: 背景色 + \x1b[K (应该铺满整行) ==="
printf '\x1b[48;2;40;50;40m complete    (1 lines)                                                       \x1b[38;2;63;185;80m✓\x1b[39m \x1b[K\x1b[0m\n'

echo "=== 测试2: 背景色 + 2K 清行 + 重写 (差量渲染模拟) ==="
printf '\x1b[48;2;40;50;40m\x1b[2K\x1b[48;2;40;50;40m complete    (1 lines)                                          \x1b[38;2;63;185;80m✓\x1b[39m \x1b[K\x1b[0m\n'

echo "=== 测试3: 原始（无patch，背景只到内容处）==="
printf '\x1b[48;2;40;50;40m complete    (1 lines)                                                       \x1b[38;2;63;185;80m✓\x1b[39m \x1b[0m\n'

echo "=== 对比：纯色整行（正确效果）==="
printf '\x1b[48;2;40;50;40m%80s\x1b[0m\n' ''
