# 插件

DeepWise 的能力由插件组合而成。内核（`packages/core/src/kernel`）本身不做任何事情：它只提供
一个服务仓库、一套事件分发，以及"谁先启动"的顺序判断。真正能跑起来的应用，是一份插件清单。

## 内核

三个概念，仅此而已。

**服务**是一份能力，用一个名字登记。`ctx.provide(name, value)` 登记，`ctx.require(name)` 取用，
同名只能有一个提供者——重复登记会抛错，因为"到底谁在提供"这件事不应该靠猜。

**注入**是启动顺序。插件声明 `inject: ["tools"]`，就会一直等到 `tools` 出现才启动。所以
`DEFAULT_PLUGINS` 是一份集合而不是一条流水线：数组里的顺序无关紧要。

**事件**有四种分发方式，区别在于监听者能做什么：

| 方式 | 语义 | 用途 |
| --- | --- | --- |
| `emit` | 各自旁观，互不影响 | 通知、埋点 |
| `parallel` | 一起旁观，等全部结束 | 需要收尾的旁观 |
| `serial` | 谁先给出答案就用谁的 | 有主有次的决策 |
| `waterfall` | 层层包裹，可调用 `next()` | 拦截、改写、替换 |

`waterfall` 的顺序是先注册的在最外层——它最先看到入参，最后看到结果，和中间件一致。
监听者调 `next()` 把手上的东西原样传下去，调 `next(改过的)` 则换掉传下去的东西——
这正是"中间件"和"前后钩子"的区别：没有后者，就只能改返回值，改不了模型将要看到的内容。

**事件不是摆设。** 两处协作真的走总线：

- `agent/prepare`（waterfall）——每一轮发出前，插件可以改系统提示词、消息、工具集
- `tools/call`（waterfall）——每一次工具调用，插件可以计时、拒绝、缓存、换个地方执行

默认都没有监听者，waterfall 直接落到 base，代价是每轮一个 promise。

每一次注册都返回一个撤销函数；插件的 `apply` 返回的那个，会在卸载时被调用。

## 现有的缝

每一条都是"一个插件提供、另一个插件可以替换掉"的位置。清单在
`packages/core/src/kernel/services.ts`，加新的缝之前请先确认真的存在第二种实现——凭空造出来的缝
和多余的间接层没有区别。

| 服务 | 名字 | 决定了什么 |
| --- | --- | --- |
| `LLM` | `llm` | 应用会说哪些模型 API（Responses、Anthropic Messages） |
| `TOOLS` | `tools` | agent 能做什么。同名后注册者胜出，替换内置工具靠的就是这一条 |
| `SKILLS` | `skills` | 代码提供的技能（磁盘上的技能不走这里） |
| `SESSION` | `session` | 每一轮的上下文在发出前由谁改。中间件，先注册的在最外层 |
| `SANDBOX` | `sandbox` | 命令在哪里跑。默认是本机，容器与远程是同一个接口 |
| `STORAGE` | `storage` | 会话存在哪。默认是 `~/.deepwise` 下的仅追加 JSONL |
| `LOOP` | `loop` | 一轮怎么跑。默认是「问、执行、再问」 |
| `SCHEDULER` | `scheduler` | 队列里下一个跑什么。默认先进先出 |
| `APPROVAL` | `approval` | 哪些动作可以无人值守地执行 |
| `COMPACTION` | `compaction` | 上下文装不下时怎么办 |

UI 不在内核里——面板属于渲染进程——但形状一样：`src/panels/registry.ts` 是一份可注册、
可按 kind 覆盖的清单，内置面板只是「先注册的那一组」。

宿主在启动时把服务绑到运行时上：

```ts
kernel = await createContext();
useLlmRegistry(kernel.require<LlmRegistry>(LLM));
useToolRegistry(kernel.require<ToolRegistry>(TOOLS));
useSandbox(kernel.require<Sandbox>(SANDBOX));
```

每个绑定点都留了静态兜底：没有绑定时用内置实现。CLI 和测试不建内核，它们不该因此少掉功能。

## 写一个插件

```ts
export const remoteSandbox: Plugin = {
	name: "remote-sandbox",
	apply(ctx) {
		return ctx.provide(SANDBOX, new SshSandbox("build-box"));
	},
};
```

换掉默认实现的方式是换掉清单，而不是改源码：

```ts
const kernel = await createContext([llmPlugin, toolsPlugin, approvalPlugin, remoteSandbox]);
```

替换一个**工具**不需要重建清单，因为工具注册表允许同名覆盖：

```ts
export const sandboxedBash: Plugin = {
	name: "sandboxed-bash",
	inject: ["tools"],
	apply(ctx) {
		return ctx.require<ToolRegistry>(TOOLS).register([myBashTool]);
	},
};
```

## 边界

九项能力都能换掉，但要说清楚换的是什么：

- 磁盘上的插件包除了技能与 MCP 配置，还可以带一个 `capability.js`，导出能力插件本身——
  它会并入 `createContext` 的清单，因此能提供或**替换**任何一条缝。加载失败会记诊断并跳过，
  别人写坏的插件不该是应用起不来的原因。
- UI 面板注册表在渲染进程里，能加面板、能按 kind 覆盖，但面板本身仍要编译进包。
  真正的"第三方 UI 插件"需要一个扩展宿主，那是另一个量级的工程。

## Trajectory

同一份仅追加日志，四种用法共用一个读取路径：**按来源查看、检索、分叉、回放**。
面板在 ⌘L；纯粹的那一半（过滤、标签、高亮）从 `@deepwise/core/trajectory-view` 导出，
读日志的那一半留在 Node 侧——渲染进程拿不到 `node:` 模块。

## 会话日志

与插件同等重要的另一半：模型看到的一切都写进仅追加的 JSONL。除消息之外，还包括

- `context`——系统提示词、工具清单、技能清单，**变化时**写入（不变就不重复写）
- `compacted`——历史何时被压缩成摘要
- `subagent` / `subagent_done`——子 Agent 的派发、它走过的步骤、它给出的回答

任务面板里点开任意一条执行记录，下方会展开参数、命令与输出。
