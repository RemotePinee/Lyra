import { useEffect, useState } from "react";
import type { AgentCapabilities } from "../../../electron/ipc-types.ts";
import { useApp } from "../../store.ts";
import { Card, EmptyHint, SectionTitle } from "./controls.tsx";

/** Tool inventory. Useful when debugging why the model did or did not have something available. */
export function CommandsSettings() {
	const activeSessionId = useApp((s) => s.activeSessionId);
	const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(useApp.getState().capabilities);

	useEffect(() => {
		if (!activeSessionId) return;
		void window.lyra.sessions.capabilities(activeSessionId).then(setCapabilities);
	}, [activeSessionId]);

	const tools = capabilities?.toolNames ?? [];
	const builtin = tools.filter((t) => !t.startsWith("mcp__"));
	const external = tools.filter((t) => t.startsWith("mcp__"));

	return (
		<div className="pt-8">
			<h1 className="text-display leading-tight font-semibold tracking-tight text-ink">命令</h1>
			<p className="mt-2 pb-7 text-label text-ink-muted">当前会话中 Agent 可以调用的全部工具。</p>

			<SectionTitle>内置工具（{builtin.length}）</SectionTitle>
			<Card className="mb-6">
				{builtin.length === 0 ? (
					<EmptyHint>打开一个会话后即可查看。</EmptyHint>
				) : (
					<div className="flex flex-wrap gap-2 p-4">
						{builtin.map((tool) => (
							<span key={tool} className="rounded-lg bg-card px-2.5 py-1 font-mono text-detail text-ink">
								{tool}
							</span>
						))}
					</div>
				)}
			</Card>

			<SectionTitle>MCP 工具（{external.length}）</SectionTitle>
			<Card>
				{external.length === 0 ? (
					<EmptyHint>没有已连接的 MCP 工具。</EmptyHint>
				) : (
					<div className="flex flex-wrap gap-2 p-4">
						{external.map((tool) => (
							<span key={tool} className="rounded-lg bg-card px-2.5 py-1 font-mono text-detail text-ink-muted">
								{tool}
							</span>
						))}
					</div>
				)}
			</Card>
		</div>
	);
}
