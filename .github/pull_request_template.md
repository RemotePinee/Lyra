<!--
Keep this short. The point of a description is that the reviewer does not have to reconstruct
your reasoning from the diff — not that a form was filled in.
-->

## 做了什么

<!-- 一两句。改的是什么，不是怎么改的。 -->

## 为什么

<!-- 什么问题让这次改动成为必要的。如果对应 issue，写 Fixes #123。 -->

## 怎么验证的

<!--
你实际跑过的，不是应该跑的。UI 改动附截图；改了 agent 行为的，说明用哪个模型、
跑了什么任务、看到什么。
-->

- [ ] `pnpm check`（lint + typecheck + test）本地通过
- [ ] 涉及 UI 的改动附了改前/改后截图
- [ ] 改了行为的地方有测试盖住

## 风险

<!-- 可能坏在哪、怎么回退。没有风险就写"无"。 -->
