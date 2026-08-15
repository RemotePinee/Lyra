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
- [ ] 深浅色、窄宽窗口都正确

## 三、共享同一份事件流：恢复 / 分叉 / 回放

- [x] **恢复**：已有（`store.load`），补一条测试证明它读的是同一份流
- [x] **分叉**：从任意 `seq` 拉出一个新会话，原会话不受影响
- [x] **回放**：按 `seq` 逐条重放，用于查看"当时到底发生了什么"
- [x] 三者共用一个读取路径，不各写一份
- [x] IPC + 前端入口：轨迹里任意一条都能"从这里分叉"

## 四、一切皆插件：补上磁盘发现

- [ ] `.deepwise/plugins/*/plugin.js` 可以导出**能力插件**（不只是技能与 MCP 配置）
- [ ] 宿主启动时把它们并入 `createContext` 的清单
- [ ] 加载失败不能拖垮启动：坏插件记诊断、跳过
- [ ] 测试：磁盘上的插件能替换掉一条内置的缝

## 五、低耦合高聚合 / 文件行数

- [ ] `core/runtime/session.ts` 642 → < 300
- [ ] `core/agent/loop.ts` 528 → < 300
- [ ] `desktop/src/App.tsx` 499 → < 300
- [ ] `settings/ModelSettings.tsx` 492 → < 300
- [ ] `components/Sidebar.tsx` 472 → < 300
- [ ] `desktop/src/layout.tsx` 465 → < 300
- [ ] `ai/openai-responses.ts` 455 → < 300
- [ ] `ai/anthropic-messages.ts` 454 → < 300
- [ ] `components/SideChat.tsx` 441 → < 300
- [ ] 全仓库无文件超过 300 行
- [ ] 新增文件均为英文注释

## 六、验收

- [ ] core 与 desktop 测试全过
- [ ] 应用启动、跑一轮真实对话
- [ ] 轨迹视图里能看到这轮的：系统提示词、思维链、每次工具调用与结果
- [ ] 从中间分叉出一个新会话并继续
- [ ] 检索能在几百条里找到指定一条
