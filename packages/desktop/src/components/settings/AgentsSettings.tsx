import { Bot } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentCapabilities } from "../../../electron/ipc-types.ts";
import { useApp } from "../../store.ts";
import { Badge, Card, EmptyHint, SectionTitle } from "./controls.tsx";

const SOURCE_LABEL: Record<string, string> = { builtin: "内置", workspace: "项目", user: "用户" };

export function AgentsSettings() {
	const activeSessionId = useApp((s) => s.activeSessionId);
	const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(useApp.getState().capabilities);

	useEffect(() => {
		if (!activeSessionId) return;
		void window.deepwise.sessions.capabilities(activeSessionId).then(setCapabilities);
	}, [activeSessionId]);

	const agents = capabilities?.agents ?? [];

	return (
		<div className="pt-8">
			<h1 className="text-[26px] leading-tight font-semibold tracking-tight text-ink">子智能体</h1>
			<p className="mt-2 max-w-[600px] pb-7 text-[13px] leading-relaxed text-ink-muted">
				主 Agent 通过 <code className="rounded bg-card px-1 py-0.5 font-mono text-[12px]">task</code>{" "}
				工具把工作交给子智能体。子智能体有独立的上下文窗口，只把最终结论交回来 —— 一次翻遍四十个文件的搜索，回到主对话里只剩一段话。
			</p>

			<SectionTitle>可用（{agents.length}）</SectionTitle>
			<Card className="mb-6">
				{agents.length === 0 ? (
					<EmptyHint>打开一个会话后即可看到可用的子智能体。</EmptyHint>
				) : (
					agents.map((agent) => (
						<div key={agent.name} className="border-b border-line-soft px-4 py-3.5 last:border-b-0">
							<div className="flex items-center gap-2">
								<Bot size={14} strokeWidth={1.8} className="shrink-0 text-info" />
								<span className="font-mono text-[13px] text-ink">{agent.name}</span>
								<Badge tone="muted">{SOURCE_LABEL[agent.source] ?? agent.source}</Badge>
								<Badge tone="muted">
									{agent.tools === "*" ? "全部工具" : `${(agent.tools as string[]).length} 个工具`}
								</Badge>
							</div>
							<p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">{agent.description}</p>
						</div>
					))
				)}
			</Card>

			<div className="rounded-[12px] border border-line bg-card/30 p-4">
				<div className="mb-2 text-[12.5px] text-ink">
					自定义子智能体：<span className="font-mono text-[12px]">.deepwise/agents/&lt;名称&gt;.md</span>
				</div>
				<pre className="overflow-x-auto rounded-lg bg-shell p-3 font-mono text-[11.5px] leading-relaxed text-ink-muted">{`---
name: migration
description: 批量迁移代码，只在明确给出迁移规则时使用。
tools: [read, edit, glob, grep, bash]
---

你是迁移执行者。按给定规则逐文件改写，改完一个就用 bash 跑一次类型检查。
不要扩大改动范围，不要顺手重构。最后汇报改了哪些文件、哪些没改以及原因。`}</pre>
			</div>
		</div>
	);
}
