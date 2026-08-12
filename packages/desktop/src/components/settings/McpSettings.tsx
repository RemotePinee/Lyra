import type { McpServerConfig } from "@deepwise/core";
import { Cable, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentCapabilities } from "../../../electron/ipc-types.ts";
import { useApp } from "../../store.ts";
import { Badge, Card, EmptyHint, Field, GhostButton, SectionTitle, Select, TextInput, Toggle } from "./controls.tsx";

/** Servers worth suggesting: widely used, no account needed to try. */
const RECOMMENDED: { id: string; name: string; detail: string; server: McpServerConfig }[] = [
	{
		id: "context7",
		name: "Context7",
		detail: "按库名拉取最新的官方文档与 API 用法，避免模型凭记忆编 API。",
		server: {
			id: "context7",
			name: "Context7",
			transport: "stdio",
			command: "npx",
			args: ["-y", "@upstash/context7-mcp@latest"],
			enabled: true,
		},
	},
	{
		id: "filesystem",
		name: "Filesystem",
		detail: "官方文件系统服务，把可访问目录限制在白名单内。",
		server: {
			id: "filesystem",
			name: "Filesystem",
			transport: "stdio",
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
			enabled: true,
		},
	},
];

export function McpSettings() {
	const settings = useApp((s) => s.settings);
	const saveSettings = useApp((s) => s.saveSettings);
	const activeSessionId = useApp((s) => s.activeSessionId);
	const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);

	useEffect(() => {
		if (!activeSessionId) return;
		void window.deepwise.sessions.capabilities(activeSessionId).then(setCapabilities);
	}, [activeSessionId]);

	if (!settings) return null;
	const servers = settings.mcpServers;

	const update = (id: string, patch: Partial<McpServerConfig>) =>
		void saveSettings({
			...settings,
			mcpServers: settings.mcpServers.map((s) => (s.id === id ? ({ ...s, ...patch } as McpServerConfig) : s)),
		});

	const add = (transport: "stdio" | "http") => {
		const id = `mcp-${Date.now().toString(36)}`;
		const server: McpServerConfig =
			transport === "stdio"
				? { id, name: "新建 stdio 服务", transport: "stdio", command: "npx", args: [], enabled: true }
				: { id, name: "新建 HTTP 服务", transport: "http", url: "https://", enabled: true };
		void saveSettings({ ...settings, mcpServers: [...settings.mcpServers, server] });
	};

	const remove = (id: string) =>
		void saveSettings({ ...settings, mcpServers: settings.mcpServers.filter((s) => s.id !== id) });

	return (
		<div className="pt-8">
			<header className="flex items-start justify-between pb-7">
				<div>
					<h1 className="text-[26px] leading-tight font-semibold tracking-tight text-ink">MCP 服务器</h1>
					<p className="mt-2 max-w-[560px] text-[13px] leading-relaxed text-ink-muted">
						连接 Model Context Protocol 服务器，它们的工具会以{" "}
						<code className="rounded bg-card px-1 py-0.5 font-mono text-[12px]">mcp__服务名__工具名</code>{" "}
						的形式加入 Agent 的工具集。改动在下一次新建会话时生效。
					</p>
				</div>
				<div className="flex shrink-0 gap-2 pt-1">
					<GhostButton onClick={() => add("stdio")}>
						<span className="flex items-center gap-1.5">
							<Plus size={12} strokeWidth={2} />
							stdio
						</span>
					</GhostButton>
					<GhostButton onClick={() => add("http")}>
						<span className="flex items-center gap-1.5">
							<Plus size={12} strokeWidth={2} />
							HTTP
						</span>
					</GhostButton>
				</div>
			</header>

			<SectionTitle>推荐</SectionTitle>
			<Card className="mb-7">
				{RECOMMENDED.map((entry) => {
					const installed = servers.some((s) => s.id === entry.id);
					return (
						<div key={entry.id} className="flex items-center gap-3 border-b border-line-soft px-4 py-3 last:border-b-0">
							<Cable size={15} strokeWidth={1.8} className="shrink-0 text-info" />
							<div className="min-w-0 flex-1">
								<div className="text-[13.5px] text-ink">{entry.name}</div>
								<div className="mt-0.5 text-[12.5px] text-ink-muted">{entry.detail}</div>
								<div className="mt-1 font-mono text-[11.5px] text-ink-faint">
									{entry.server.transport === "stdio"
										? `${entry.server.command} ${(entry.server.args ?? []).join(" ")}`
										: entry.server.url}
								</div>
							</div>
							<GhostButton
								disabled={installed}
								onClick={() => void saveSettings({ ...settings, mcpServers: [...settings.mcpServers, entry.server] })}
							>
								{installed ? "已添加" : "添加"}
							</GhostButton>
						</div>
					);
				})}
			</Card>

			<SectionTitle>已配置（{servers.length}）</SectionTitle>

			{servers.length === 0 ? (
				<Card>
					<EmptyHint>
						还没有配置 MCP 服务器。
						<br />
						例如 stdio 方式的文件系统服务：命令 <span className="font-mono">npx</span>，参数{" "}
						<span className="font-mono">-y @modelcontextprotocol/server-filesystem /path</span>
					</EmptyHint>
				</Card>
			) : (
				<div className="space-y-3">
					{servers.map((server) => {
						const status = capabilities?.mcp.find((m) => m.id === server.id);
						return (
							<Card key={server.id}>
								<div className="flex items-center gap-2.5 border-b border-line-soft px-4 py-3">
									<Cable size={15} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
									<input
										value={server.name}
										onChange={(e) => update(server.id, { name: e.target.value })}
										className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink focus:outline-none"
									/>
									<Badge tone="muted">{server.transport}</Badge>
									{status?.state === "connected" && <Badge tone="ok">{status.toolCount} 个工具</Badge>}
									{status?.state === "failed" && <Badge tone="danger">连接失败</Badge>}
									<Toggle checked={server.enabled} onChange={(enabled) => update(server.id, { enabled })} />
									<button
										type="button"
										title="删除"
										onClick={() => remove(server.id)}
										className="text-ink-faint transition-colors hover:text-danger"
									>
										<Trash2 size={14} strokeWidth={1.8} />
									</button>
								</div>

								<div className="space-y-3 px-4 py-3.5">
									{server.transport === "stdio" ? (
										<>
											<Field label="命令">
												<TextInput
													value={server.command}
													onChange={(command) => update(server.id, { command })}
													mono
													placeholder="npx"
												/>
											</Field>
											<Field label="参数" hint="空格分隔">
												<TextInput
													value={(server.args ?? []).join(" ")}
													onChange={(value) =>
														update(server.id, { args: value.split(" ").filter(Boolean) })
													}
													mono
													placeholder="-y @modelcontextprotocol/server-filesystem /Users/me/code"
												/>
											</Field>
										</>
									) : (
										<>
											<Field label="URL">
												<TextInput
													value={server.url}
													onChange={(url) => update(server.id, { url })}
													mono
													placeholder="https://mcp.example.com/mcp"
												/>
											</Field>
											<Field label="传输方式">
												<Select
													value={server.transport}
													onChange={(transport) => update(server.id, { transport })}
													options={[
														{ value: "http", label: "Streamable HTTP" },
														{ value: "sse", label: "SSE" },
													]}
												/>
											</Field>
										</>
									)}

									{status?.error && (
										<div className="rounded-lg border border-danger/35 bg-danger/8 px-3 py-2 text-[12px] text-danger">
											{status.error}
										</div>
									)}

									{status?.tools && status.tools.length > 0 && (
										<details>
											<summary className="cursor-pointer text-[12px] text-ink-muted">
												查看 {status.tools.length} 个工具
											</summary>
											<div className="mt-2 space-y-1">
												{status.tools.map((tool) => (
													<div key={tool.name} className="text-[12px]">
														<span className="font-mono text-ink">{tool.name}</span>
														<span className="ml-2 text-ink-faint">{tool.description.slice(0, 120)}</span>
													</div>
												))}
											</div>
										</details>
									)}
								</div>
							</Card>
						);
					})}
				</div>
			)}
		</div>
	);
}
