# 扩展 DeepWise

DeepWise 的能力由四种东西扩展：**插件**、**技能**、**MCP 服务**、**子智能体**。

插件是前三者的打包形式——一个插件目录里可以同时带技能和 MCP 服务。技能和 MCP
也可以单独放，不必装进插件。

设置界面只负责开关和安装，格式细节都在这里。

---

## 插件

### 目录结构

```
my-plugin/
├── .deepwise-plugin/plugin.json   清单：name、skills、mcpServers、interface
├── skills/
│   └── changelog/
│       ├── SKILL.md               说明书（name + description 必填）
│       ├── scripts/collect.sh     技能自带的脚本
│       └── assets/                模板、样式等资源
└── .mcp.json                      { "mcpServers": { "context7": { … } } }
```

清单里 `skills` 指向技能目录，`mcpServers` 指向一个 `.mcp.json`，`interface` 提供显示
名、分类、品牌色和示例提示。

### 安装位置

| 位置 | 路径 | 作用范围 |
| --- | --- | --- |
| 用户级 | `~/.deepwise/plugins/` | 所有工作区 |
| 项目级 | `<工作区>/.deepwise/plugins/` | 仅该工作区，可随仓库提交 |

同名插件以项目级为准。

### 与 Codex 的兼容

同时识别 `.codex-plugin/plugin.json` 布局，现成的 Codex 插件包可以直接放进目录，
不需要改造。两种清单文件同时存在时以 `.deepwise-plugin/` 为准。

---

## 技能

技能是一份写给模型看的说明书。目录里必须有 `SKILL.md`，frontmatter 的 `name` 和
`description` 是必填项——`description` 决定模型在什么时候想起这个技能，所以要写
清楚**触发条件**，而不只是功能。

```markdown
---
name: pdf-report
description: 生成带图表的 PDF 报表。当用户要求导出报表、生成 PDF 时使用。
allowed-tools: [read, write, bash]
---

# 生成 PDF 报表

1. 先用 `read` 确认数据源结构
2. 用 reportlab 生成，模板在 templates/report.py
3. 输出到 out/report-<日期>.pdf 并把路径回给用户
```

`allowed-tools` 可选，限制这个技能执行期间能用的工具。省略表示不额外限制。

技能目录里的 `scripts/`、`assets/` 等子目录会随技能一起被找到，正文里用相对路径
引用即可。

同名技能以工作区里的松散技能优先，插件里的会让位。

只有 `name` 和 `description` 常驻上下文（每个技能约几十 token），正文在技能被真正
用到时才读入——所以装很多技能不会撑爆上下文。

---

## MCP 服务

在 `.mcp.json` 或插件清单的 `mcpServers` 字段里声明：

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    }
  }
}
```

### 和技能的区别

两者经常被混为一谈，实际是不同层的东西：

|  | 技能 | MCP |
| --- | --- | --- |
| 是什么 | 一段写给模型的说明书 | 一个对外的工具服务进程 |
| 提供什么 | 做事的方法、步骤、约定 | 可调用的函数 |
| 怎么进上下文 | 名称 + 描述常驻，正文按需注入 | 工具签名进工具表 |
| 谁执行 | 模型按说明用已有工具去做 | 服务端进程执行后返回结果 |

MCP 让 Agent 够得着外部系统，技能告诉它够着之后该干什么。

插件带来的 MCP 服务默认关闭，需要在设置里手动启用；新建会话后生效。

---

## 子智能体

子智能体有独立的上下文窗口，只把最终结论交回主对话——一次翻遍四十个文件的搜索，
回到主对话里只剩一段话。主 Agent 通过 `task` 工具把工作交给它。

放在 `.deepwise/agents/<名称>.md`：

```markdown
---
name: migration
description: 批量迁移代码，只在明确给出迁移规则时使用。
tools: [read, edit, glob, grep, bash]
---

你是迁移执行者。按给定规则逐文件改写，改完一个就用 bash 跑一次类型检查。
不要扩大改动范围，不要顺手重构。最后汇报改了哪些文件、哪些没改以及原因。
```

`description` 同样是调度依据，要写清楚**什么时候该派它出去**。`tools` 省略表示继承
主 Agent 的全部工具。
