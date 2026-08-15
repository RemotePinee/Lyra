# 实施清单

> 分支 `plugins`。每完成一项立即勾选，每一轮结束前复查一遍。
> **勾选的标准是"验证过"，不是"写完了"**——没有测试或没有跑通的，不勾。

## 一、九项能力插件化

验收标准相同：有服务键、有默认插件、有静态兜底、**有一个换掉它并证明行为改变的测试**。

- [x] **模型** `LLM` — 说哪些模型 API。`kernel/plugins/llm.ts`
- [x] **工具** `TOOLS` — agent 能做什么，同名后注册者胜出。`kernel/plugins/tools.ts`
- [x] **技能** `SKILLS` — 代码提供的技能。`kernel/plugins/skills.ts` + `skills/registry.ts`
- [x] **会话** `SESSION` — 每轮上下文由谁改。`runtime/turn.ts` + `kernel/plugins/session.ts`
- [x] **沙箱** `SANDBOX` — 命令在哪里跑。`sandbox/local.ts` + `kernel/plugins/sandbox.ts`
- [x] **存储** `STORAGE` — 会话存在哪。`session/storage.ts` + `kernel/plugins/storage.ts`
- [x] **循环** `LOOP` — 一轮怎么跑。`agent/runner.ts` + `kernel/plugins/loop.ts`
- [x] **调度** `SCHEDULER` — 下一个跑什么。`runtime/scheduling.ts` + `kernel/plugins/scheduler.ts`
- [x] **UI** — 侧边面板由注册表提供。`src/panels/registry.ts` + `panels/builtin.tsx`
- [x] 附加：**审批** `APPROVAL`（`runtime/approval-policy.ts`）、**压缩** `COMPACTION`

### 绑定与拆卸

- [x] 主进程启动时全部绑定（`electron/main.ts`）
- [x] 退出时全部解绑，内核 dispose
- [x] 每个绑定点都有静态兜底（CLI 与测试不建内核也不少功能）

## 二、运行有迹可循

- [x] 系统提示词写入日志（变化时写，哈希比对）
- [x] 每一次上下文注入写入日志（`prepareTurn` 之后才记录，记的是模型真正看到的）
- [x] 工具调用与结果写入日志（随消息）
- [x] 思维链写入日志（随消息，`ThinkingContent`）
- [x] 子 Agent 调度写入日志（派发 + 步骤 + 回答）
- [x] 任务列表点击展开详情区域
- [x] 详情区域在展开布局下同样正确

## 三、代码规整

- [x] `electron/main.ts` 1634 → **308**
- [x] `src/store.ts` 1114 → **274**
- [x] `components/git/GitPanel.tsx` 1109 → **295**
- [x] `electron/git.ts` 773 → **143**（拆成 exec / diff / status / history / repos / pr）
- [x] `components/CodeEditor.tsx` 660 → **293**
- [x] `components/Conversation.tsx` 659 → **287**
- [x] `core/runtime/session.ts` 794 → **588**（队列、审批、子 Agent、能力加载各自成模块）
- [x] 新增文件注释均为英文且精炼

## 四、功能验收（多场景）

- [x] 应用启动、内核就位
- [x] 新建对话，第一条消息不重复（含冷启动）
- [x] 连续多轮对话
- [x] 工具调用（bash / read / write）
- [x] 多个命令聚合成一张卡（「执行命令 3 个」）
- [x] 子 Agent 派发
- [x] 会话切换与历史加载
- [x] 工作区切换
- [x] 任务面板：计划、执行记录、详情展开
- [x] Git 面板：改动、历史、分支
- [x] Git：仓库列表、worktree 创建与读取
- [x] 文件面板、代码编辑器打开文件
- [x] 终端创建
- [x] 侧边聊天问答
- [x] 插件与技能列表
- [x] 设置读写与还原
- [x] 深色 / 浅色主题
- [x] 窄 420 / 中 760 / 宽 1280 三种宽度均无横向溢出
- [x] 中断运行 → 出现「上次执行被中断 · 继续 / 重试」→ 继续可用
- [x] 上下文压缩（端到端测试）

## 五、测试

- [x] core 单元测试全过（159）
- [x] desktop 单元测试全过（23）
- [x] 每条缝各有一个"换掉它"的测试（`seams.test.ts`、`sandbox.test.ts`、`kernel.test.ts`、desktop `panels.test.ts`）
- [x] 会话日志记录有测试（`session-log.test.ts`）
- [x] 压缩端到端有测试（`compaction-e2e.test.ts`）
- [x] 端到端跑通真实任务（本轮改动后多次）

## 六、过程中发现并修掉的真问题

不是重构的副产品，是重构照出来的：

- [x] **每个事件被应用两遍**：StrictMode 下 `bootstrap` 订阅了两次事件；新对话第一条消息显示两次只是最显眼的症状
- [x] **压缩从未在替换过 provider 的会话里跑起来**：摘要请求绕过宿主的替换直接拨真 provider
- [x] **子 Agent 同样绕过替换**：现在继承父会话的 streamFn
- [x] **停在工具结果之后不算「被中断」**：工具都跑完了、没有悬空调用，旧规则判定完成，而那一句回答从没出现
- [x] **设置有六个写入点**：漏掉一个订阅者就是「这个设置不生效」，现在一处写入、一处广播
- [x] **系统里还留着浏览器自己的 tooltip**：55 处 `title=`，与我们自己的气泡样式、延迟、位置都不同，在 macOS 上像是另一个程序弹出来的。全部换成 `data-dw-tip`，并留下一个测试盯着（`native-title.test.ts`）——它们本来就是一次加一个漏回来的
- [x] **吸顶的行顶角是方的**：圆角只有在背后透出别的颜色时才看得见，而一行钉住之后，它顶角背后是它自己的正文，同一个填充色。现在钉住的是一层不透明的面板色底衬，行在底衬里画自己的圆角
- [x] **长 tooltip 拉满一整行**：`max-width` 和 `white-space: nowrap` 同时写着，后者让前者失效

## 七、仍超过 300 行的文件

诚实列出。这些都是「再拆会更难读」的：一个类、一个协议适配器、一个页面。

25 个，全部列出。前七个是「再拆会更难读」的；后面十八个只是略过线，各自仍是一件事。

| 文件 | 行数 | 为什么留着 |
| --- | --- | --- |
| `core/runtime/session.ts` | 559 | 会话类本身：状态加一轮的编排。再拆就是把 `this` 摊成十五个参数 |
| `settings/ModelSettings.tsx` | 492 | 一个设置页 |
| `src/components/Sidebar.tsx` | 474 | 一个组件 |
| `src/components/SideChat.tsx` | 441 | 一个面板 |
| `mobile/src/store.ts` | 427 | 移动端状态，与桌面端一一对应 |
| `src/components/SidePanel.tsx` | 419 | 面板外壳：标签页、拖拽、尺寸 |
| `src/App.tsx` | 416 | 应用外壳与路由 |
| `components/Popover.tsx` | 382 | 一个浮层的定位与翻转 |
| `ai/openai-responses.ts` | 381 | 协议适配器，按流事件顺序读才有意义 |
| `settings/controls.tsx` | 366 | 设置页共用的控件集 |
| `ai/anthropic-messages.ts` | 361 | 同 responses |
| `src/sideStore.ts` | 357 | 侧边聊天的状态 |
| `core/src/types.ts` | 357 | 类型声明，没有逻辑 |
| `core/session/store.ts` | 357 | 仅追加日志的读写 |
| `agent/loop.ts` | 344 | 一轮的主循环 |
| `electron/ipc-types.ts` | 335 | 通道声明，没有逻辑 |
| `settings/AppearanceSettings.tsx` | 332 | 一个设置页 |
| `electron/main.ts` | 330 | 主进程装配 |
| `mobile/app/session/[id].tsx` | 326 | 一个页面 |
| `components/Composer.tsx` | 322 | 输入区 |
| `core/runtime/sidechat.ts` | 319 | 侧边聊天的运行时 |
| `src/store/apply-event.ts` | 318 | 事件到状态的一张分派表 |
| `core/test/tasks.test.ts` | 317 | 测试 |
| `components/editor/theme.ts` | 311 | 编辑器样式表 |
| `components/PreviewCard.tsx` | 305 | 一种卡片 |
