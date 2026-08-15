import type { Plugin } from "@deepwise/core";
import { Cable, FolderOpen, Sparkles, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useApp } from "../../store.ts";
import { Badge, Card, GhostButton, SectionTitle, Toggle } from "./controls.tsx";
import { PluginIcon } from "./PluginIcon.tsx";

const SOURCE_LABEL: Record<string, string> = { workspace: "项目", user: "用户" };

export function PluginsSettings({ filter = "" }: { filter?: string }) {
	const settings = useApp((s) => s.settings);
	const saveSettings = useApp((s) => s.saveSettings);
	const workspace = useApp((s) => s.workspace);
	const [scan, setScan] = useState<Awaited<ReturnType<typeof window.deepwise.plugins.list>> | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = async () => setScan(await window.deepwise.plugins.list(workspace?.path ?? ""));

	useEffect(() => {
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [workspace?.path, settings?.disabledPlugins.length]);

	if (!settings) return null;
	const needle = filter.trim().toLowerCase();
	const plugins = (scan?.plugins ?? []).filter(
		(p) =>
			!needle ||
			`${p.id} ${p.manifest.name ?? ""} ${p.manifest.interface?.shortDescription ?? ""}`
				.toLowerCase()
				.includes(needle),
	);
	const diagnostics = scan?.pluginDiagnostics ?? [];

	/*
	 * `*` in `disabledPlugins` means "none of them", whoever wrote it there.
	 *
	 * Switching one back on has to clear that as well, or the toggle is a control that reports a
	 * change and produces none: the id is removed, the wildcard stays, and every plugin is still
	 * off after a reload. Turning the wildcard off means naming what it stood for — everything
	 * currently on disk except the one being switched on.
	 */
	const allOff = settings.disabledPlugins.includes("*");

	const toggle = (plugin: Plugin, enabled: boolean) => {
		const disabled = new Set(settings.disabledPlugins);
		if (allOff && enabled) {
			disabled.delete("*");
			for (const other of scan?.plugins ?? []) if (other.id !== plugin.id) disabled.add(other.id);
		}
		if (enabled) disabled.delete(plugin.id);
		else disabled.add(plugin.id);
		void saveSettings({ ...settings, disabledPlugins: [...disabled] });
	};

	return (
		<div>
			<header className="flex items-start justify-end pb-4">
				<div className="flex shrink-0 gap-2">
					<GhostButton onClick={() => void window.deepwise.plugins.revealDir("user", workspace?.path ?? "")}>
						<span className="flex items-center gap-1.5">
							<FolderOpen size={12} strokeWidth={1.9} />
							用户目录
						</span>
					</GhostButton>
					{workspace && (
						<GhostButton onClick={() => void window.deepwise.plugins.revealDir("workspace", workspace.path)}>
							<span className="flex items-center gap-1.5">
								<FolderOpen size={12} strokeWidth={1.9} />
								项目目录
							</span>
						</GhostButton>
					)}
				</div>
			</header>

			{diagnostics.length > 0 && (
				<Card className="mb-6 border-accent/35 bg-accent/6">
					<div className="px-4 py-3">
						<div className="mb-2 flex items-center gap-1.5 text-[12.5px] text-accent">
							<TriangleAlert size={13} strokeWidth={1.9} />
							{diagnostics.length} 个插件问题
						</div>
						{diagnostics.map((diagnostic) => (
							<div key={diagnostic.path} className="py-0.5 text-[12px] text-accent/85">
								<span className="font-mono">{diagnostic.path}</span> — {diagnostic.message}
							</div>
						))}
					</div>
				</Card>
			)}

			<SectionTitle>已安装（{plugins.length}）</SectionTitle>

			{plugins.length === 0 ? (
				<Card>
					<div className="px-4 py-8 text-center">
						<p className="text-[12.5px] leading-relaxed text-ink-muted">
							还没有插件。把插件目录放进上面的目录即可，或者装一个示例看看格式。
						</p>
						<button
							type="button"
							disabled={busy}
							onClick={async () => {
								setBusy(true);
								try {
									await window.deepwise.plugins.installExample(workspace ? "workspace" : "user", workspace?.path ?? "");
									await refresh();
								} finally {
									setBusy(false);
								}
							}}
							className="mt-4 h-8 rounded-lg bg-ink px-3.5 text-[12.5px] font-medium text-shell transition-opacity hover:opacity-90 disabled:opacity-50"
						>
							{busy ? "安装中…" : "安装示例插件"}
						</button>
						<p className="mt-3 text-[11.5px] text-ink-faint">安装后需要新建会话才会生效</p>
					</div>
				</Card>
			) : (
				<div className="space-y-3">
					{/*
					 * Said out loud, because otherwise the page is a list of plugins that are all off
					 * for no visible reason — indistinguishable from having switched each one off.
					 */}
					{allOff && (
						<p className="rounded-[10px] border border-line-soft px-3 py-2 text-[12px] leading-relaxed text-ink-muted">
							设置里写着 <code className="font-mono">disabledPlugins: ["*"]</code>，所以下面所有插件都不生效。
							把任意一个拨回「开」会解除这条总开关，其余插件保持当前状态。
						</p>
					)}
					{plugins.map((plugin) => (
						<PluginCard key={plugin.id} plugin={plugin} onToggle={(enabled) => toggle(plugin, enabled)} />
					))}
				</div>
			)}
		</div>
	);
}

function PluginCard({ plugin, onToggle }: { plugin: Plugin; onToggle: (enabled: boolean) => void }) {
	const ui = plugin.manifest.interface;
	const [open, setOpen] = useState(false);

	return (
		<Card>
			<div className="flex items-center gap-3 px-4 py-3">
				<PluginIcon
					name={ui?.displayName ?? plugin.manifest.name ?? plugin.id}
					logo={ui?.logo}
					brandColor={ui?.brandColor}
				/>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="truncate text-[13.5px] text-ink">{ui?.displayName ?? plugin.manifest.name}</span>
						{plugin.manifest.version && <Badge tone="muted">v{plugin.manifest.version}</Badge>}
						<Badge tone="muted">{SOURCE_LABEL[plugin.source] ?? plugin.source}</Badge>
						{ui?.category && <Badge tone="muted">{ui.category}</Badge>}
					</div>
					<p className="mt-0.5 truncate text-[12.5px] text-ink-muted">
						{ui?.shortDescription ?? plugin.manifest.description ?? "（无描述）"}
					</p>
				</div>
				<Toggle checked={plugin.enabled} onChange={onToggle} />
			</div>

			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line-soft px-4 py-2.5 text-[12px] text-ink-muted">
				<span className="flex items-center gap-1.5">
					<Sparkles size={12} strokeWidth={1.9} className="text-violet" />
					{plugin.skills.length} 个技能
				</span>
				<span className="flex items-center gap-1.5">
					<Cable size={12} strokeWidth={1.9} className="text-info" />
					{plugin.mcpServers.length} 个 MCP 服务
				</span>
				<div className="flex-1" />
				<button
					type="button"
					onClick={() => setOpen((v) => !v)}
					className="text-[12px] text-ink-faint transition-colors hover:text-ink"
				>
					{open ? "收起" : "详情"}
				</button>
				<button
					type="button"
					onClick={() => void window.deepwise.system.openPath(plugin.dir)}
					className="text-[12px] text-ink-faint transition-colors hover:text-ink"
				>
					打开目录
				</button>
			</div>

			{open && (
				<div className="dw-enter space-y-3 border-t border-line-soft px-4 py-3">
					{ui?.longDescription && (
						<p className="text-[12.5px] leading-relaxed text-ink-muted">{ui.longDescription}</p>
					)}

					{plugin.skills.length > 0 && (
						<div>
							<div className="mb-1.5 text-[11px] tracking-wide text-ink-faint uppercase">技能</div>
							{plugin.skills.map((skill) => (
								<div key={skill.name} className="py-0.5 text-[12px]">
									<span className="font-mono text-ink">{skill.name}</span>
									<span className="ml-2 text-ink-muted">{skill.description.slice(0, 90)}</span>
								</div>
							))}
						</div>
					)}

					{plugin.mcpServers.length > 0 && (
						<div>
							<div className="mb-1.5 text-[11px] tracking-wide text-ink-faint uppercase">MCP 服务</div>
							{plugin.mcpServers.map((server) => (
								<div key={server.id} className="py-0.5 font-mono text-[12px] text-ink-muted">
									{server.name} · {server.transport} ·{" "}
									{server.transport === "stdio" ? `${server.command} ${(server.args ?? []).join(" ")}` : server.url}
								</div>
							))}
						</div>
					)}

					{ui?.defaultPrompt && ui.defaultPrompt.length > 0 && (
						<div>
							<div className="mb-1.5 text-[11px] tracking-wide text-ink-faint uppercase">示例提示</div>
							{ui.defaultPrompt.map((prompt) => (
								<div key={prompt} className="py-0.5 text-[12px] text-ink-muted">
									· {prompt}
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</Card>
	);
}
