# 实施清单

> 分支 `plugins`。每完成一项立即勾选，每一轮结束前复查一遍。
> **勾选的标准是"验证过"，不是"写完了"**——没有测试或没有跑通的，不勾。

## 一、九项能力插件化

验收标准相同：有服务键、有默认插件、有静态兜底、**有一个换掉它并证明行为改变的测试**。

- [x] **模型** `LLM` — 说哪些模型 API。`kernel/plugins/llm.ts`
- [x] **工具** `TOOLS` — agent 能做什么。同名后注册者胜出。`kernel/plugins/tools.ts`
- [x] **技能** `SKILLS` — 代码提供的技能。`kernel/plugins/skills.ts`
- [x] **会话** `SESSION` — 每轮上下文由谁改。`runtime/turn.ts` + `kernel/plugins/session.ts`
- [x] **沙箱** `SANDBOX` — 命令在哪里跑。`sandbox/local.ts`
- [x] **存储** `STORAGE` — 会话存在哪。`session/storage.ts` + `kernel/plugins/storage.ts`
- [x] **循环** `LOOP` — 一轮怎么跑。`agent/runner.ts` + `kernel/plugins/loop.ts`
- [x] **调度** `SCHEDULER` — 下一个跑什么。`runtime/scheduling.ts` + `kernel/plugins/scheduler.ts`
- [x] **UI** — 侧边面板由注册表提供。`src/panels/registry.ts` + `panels/builtin.tsx`
- [x] 附加：**审批** `APPROVAL`、**压缩** `COMPACTION`

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

当前行数见每项括号。

- [ ] `electron/main.ts` < 300 行（现 1230）
- [ ] `src/store.ts` < 300 行（现 844）
- [ ] `core/runtime/session.ts` < 300 行（现 800）
- [ ] `electron/git.ts` < 300 行（现 773）
- [ ] `src/components/CodeEditor.tsx` < 300 行（现 660）
- [ ] `src/components/Conversation.tsx` < 300 行（现 659）
- [ ] 全仓库无文件超过 300 行
- [x] 新增文件注释均为英文且精炼

## 四、功能验收（多场景）

- [x] 应用启动、内核就位
- [x] 新建对话，第一条消息不重复（**冷启动也不重复**——根因是 StrictMode 下 `bootstrap` 订阅了两次事件，每个事件被应用两遍）
- [x] 连续多轮对话
- [x] 工具调用（bash / read / write）
- [x] 子 Agent 派发
- [ ] 会话切换与历史加载
- [x] 任务面板：计划、执行记录、详情展开
- [x] Git 面板：改动、历史、分支
- [ ] Git 面板：仓库切换 / worktree
- [x] 文件面板、终端
- [x] 侧边聊天
- [x] 插件与技能列表
- [ ] 设置读写
- [ ] 深色主题
- [ ] 窄窗口布局
- [ ] 中断与继续
- [ ] 上下文压缩（端到端）

## 五、测试

- [x] core 单元测试全过（131）
- [x] desktop 单元测试全过（13）
- [x] 每条缝各有一个"换掉它"的测试（`test/seams.test.ts`、`test/sandbox.test.ts`、`test/kernel.test.ts`、desktop `test/panels.test.ts`）
- [x] 会话日志记录有测试
- [ ] 端到端跑通一次真实任务（本轮改动后）
