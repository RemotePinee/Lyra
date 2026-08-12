---
name: changelog
description: 整理 git 提交为分类变更日志。当用户要求写 changelog、发布说明、版本变更时使用。
---

# 整理变更日志

1. 运行本技能自带的脚本拿到结构化提交：
   `bash scripts/collect.sh 30`
2. 按 Added / Changed / Fixed 归类
3. 每条一句话，写清楚对用户的影响，不要写实现细节

脚本路径相对于本技能目录，调用时请使用系统提示里给出的绝对路径。
