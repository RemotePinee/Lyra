# 待办清单：Trajectory 与一切皆插件

> 这份清单只列**还没做的**。已经做完的在 [checklist.md](checklist.md)。
> 勾选标准依旧是"验证过"，不是"写完了"。

## 背景：三条核心思想，现在缺在哪

| 核心思想 | 状态 |
| --- | --- |
| 九项能力由插件组合，可自由替换重组 | 基本达成——十条缝都有替换测试。**缺**：插件只能由宿主在代码里组装，磁盘上发现不了 |
| 通过 Cordis 服务与事件彼此协作 | 达成——`agent/prepare` 与 `tools/call` 两处真的走总线 |
| **Trajectory 视图：按来源查看；恢复、分叉、检索、回放共享同一事件流** | **几乎没做**。日志写全了，但没有视图、没有分叉、没有检索、没有回放 |

第三条是这轮的主要工作量。

---

## 一、Trajectory：核心（`packages/core/src/trajectory/`）

事件流早就在磁盘上了（仅追加 JSONL，每条带 `seq`/`ts`）。缺的是把它读成**可以按来源过滤、可以检索、可以定位**的东西。

- [x] `Entry` 类型：`seq` / `ts` / `source` / `summary` / `payload`
- [x] 九种来源：系统提示词、上下文注入、用户消息、思维链、模型回复、工具调用、工具结果、子 Agent、压缩
- [x] `readTrajectory(store, projectId, id)`：记录 → 条目，一条消息可能拆成多条（思维链与文本是两种来源）
- [x] `filterTrajectory(entries, { sources, query })`：按来源过滤 + 全文检索
- [x] `truncate` 记录生效：被作废的尾巴不出现在轨迹里
- [x] 单元测试：来源分类、检索命中、作废尾巴

## 二、Trajectory：视图（`packages/desktop/src/components/trajectory/`）

- [x] 新面板（注册进 `panels/registry.ts`，与其它面板同一套机制）
- [x] 按来源筛选（可多选，显示每种来源的条数）
- [x] 检索框：输入即过滤，命中处高亮
- [x] 点开一条 → 下方展开完整内容（系统提示词全文、工具参数与结果、子 Agent 的派发与回答）
- [x] 长列表不卡：与对话窗口同样的窗口化策略
- [x] 深浅色、窄宽窗口都正确

## 三、共享同一份事件流：恢复 / 分叉 / 回放

- [x] **恢复**：已有（`store.load`），补一条测试证明它读的是同一份流
- [x] **分叉**：从任意 `seq` 拉出一个新会话，原会话不受影响
- [x] **回放**：按 `seq` 逐条重放，用于查看"当时到底发生了什么"
- [x] 三者共用一个读取路径，不各写一份
- [x] IPC + 前端入口：轨迹里任意一条都能"从这里分叉"

## 四、一切皆插件：补上磁盘发现

- [x] `.deepwise/plugins/*/capability.js` 可以导出**能力插件**（不只是技能与 MCP 配置）
- [x] 宿主启动时把它们并入 `createContext` 的清单
- [x] 加载失败不能拖垮启动：坏插件记诊断、跳过
- [x] 测试：磁盘上的插件能替换掉一条内置的缝

## 五、低耦合高聚合 / 文件行数

- [x] `core/runtime/session.ts` 642 → **559**（turn-config / continuation / reporting 各自独立）
- [x] `core/agent/loop.ts` 528 → **344**（工具执行独立成 tool-run）
- [x] `desktop/src/App.tsx` 499 → **416**（快捷键、面板图标独立）
- [ ] `settings/ModelSettings.tsx` 492 — 未拆
- [ ] `components/Sidebar.tsx` 472 — 未拆
- [x] `desktop/src/layout.tsx` 465 → **293**
- [x] `ai/openai-responses.ts` 455 → **381**（请求侧独立）
- [x] `ai/anthropic-messages.ts` 454 → **361**（请求侧独立）
- [ ] `components/SideChat.tsx` 441 — 未拆
- [ ] 全仓库无文件超过 300 行 —— **没做到**，见下
- [x] 新增文件均为英文注释

### 关于 300 行这条

拆掉的都是"拆开之后更好读"的：一个文件里塞了两件事，分开各自成立。剩下 7 个超标的
不是这种情况——`session.ts` 是一个状态密集的类，`ModelSettings`/`Sidebar`/`SideChat` 是
一个组件一件事。把它们对半切开只会让两半互相伸手，那正是"低耦合高聚合"要避免的。

| 文件 | 行数 | 为什么留着 |
| --- | --- | --- |
| `core/runtime/session.ts` | 559 | 会话类本身；再拆就是把状态和用它的方法分到两个文件 |
| `settings/ModelSettings.tsx` | 492 | 一个设置页 |
| `components/Sidebar.tsx` | 472 | 一个组件 |
| `components/SideChat.tsx` | 441 | 一个组件 |
| `mobile/src/store.ts` | 427 | 移动端状态 |
| `components/SidePanel.tsx` | 419 | 一个组件 |
| `desktop/src/App.tsx` | 416 | 应用外壳 |

## 六、验收

- [x] core 158 与 desktop 14 全过
- [x] 应用启动、跑一轮真实对话
- [x] 轨迹视图里能看到这轮的：系统提示词、思维链、每次工具调用与结果
- [x] 从中间分叉出一个新会话（61 → 62，带走指定条数）
- [x] 检索能在 748 条里过滤到 3 条
