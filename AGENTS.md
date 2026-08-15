# 给在这个仓库里干活的 agent

这份文件写给自动化——包括本仓库自带的那个 agent，以及任何被叫来改这份代码的模型。
人要看的东西在 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 一句话

DeepWise 是一个 agent 运行时加两个前端。`packages/core` 平台无关，桌面端（Electron）
和移动端（Expo）驱动同一个 `AgentSession`。

## 改动之前

```bash
pnpm install
```

## 改动之后（必须全过）

```bash
pnpm lint        # oxlint，--deny-warnings：警告等于失败
pnpm typecheck   # 三个包
pnpm test        # 190 个单元测试
```

或者一条：`pnpm check`。

**不要为了让检查通过而放宽检查。** 规则报出来的如果是误报，加行内 `oxlint-disable-next-line`
并在同一行写明理由；不要去改 `.oxlintrc.json` 把规则关掉，除非你能说清楚这条规则
对整个仓库都不适用。

## 硬约束

- **缩进 tab**，YAML/JSON 用 2 空格
- **注释用英文，解释为什么**，不复述代码做了什么
- **单文件尽量 300 行以内**，但拆分要有真实边界，不要对半切
- **不要动 `docs/`**：那是本地笔记，已经在 `.gitignore` 里
- **不要提交任何密钥**。模型配置在 `~/.deepwise/settings.json`，不在仓库里
- 改了行为就补测试。规则性的代码（分组、风险判定、去重）尤其要测

## 容易踩的坑

- **Node 的 `--experimental-strip-types` 不支持构造函数参数属性**。`constructor(private x: T) {}`
  能通过 tsc 但会让测试整个文件挂掉。写成显式字段赋值。
- **测试用 `node:test`**，不是 vitest/jest。别引测试框架。
- **core 不能 import 任何端上的东西**，反过来也一样：**渲染进程不能从 `@deepwise/core`
  根入口导入"值"**。类型（`import type`）编译期就擦掉了，没有代价；值会把整个 index 拉进
  浏览器，而 index 一路连到 `node:fs`、`node:child_process`——bundle 加载、在第一个 Node
  内置模块上抛错、窗口一片空白。浏览器要用的东西走子入口：`@deepwise/core/schedule`、
  `@deepwise/core/trajectory-view`、`@deepwise/core/activity`。
- **给 core 加了新的子入口，要重启 dev server**。Vite 缓存 exports 解析，不重启会报
  "not exported under the conditions"。
- **改了 core 要重启桌面端**，HMR 只覆盖渲染进程；主进程里的 core 代码不会热更新。
- **`position: sticky` 会被任何祖先的 `overflow: hidden` 破坏**。

## 目录

| 路径 | 是什么 |
| --- | --- |
| `packages/core/src/agent/` | 一轮循环、工具执行、重复检测 |
| `packages/core/src/runtime/` | 会话、日志、审批、任务队列、压缩 |
| `packages/core/src/tools/` | 内置工具。`risk*.ts` 判定哪些命令需要人来点头 |
| `packages/core/src/kernel/` | 插件内核：服务、事件、十条缝 |
| `packages/desktop/electron/` | 主进程：IPC、窗口、Git、同步服务 |
| `packages/desktop/src/` | 渲染进程 |
| `packages/mobile/` | Expo 应用 |

## 提交

主题一行中文，说清楚解决了什么问题；正文讲为什么。不要写"修复若干问题"。
