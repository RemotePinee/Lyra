import { Blocks, Cable, ChevronDown, Plus, Sparkles, Store } from "lucide-react";
import { useEffect, useState } from "react";

import { MenuItem, Popover, usePopover } from "../Popover.tsx";
import { SearchField } from "../SearchField.tsx";
import { useApp } from "../../store.ts";
import { McpSettings } from "./McpSettings.tsx";
import { PluginsSettings } from "./PluginsSettings.tsx";
import { SkillsSettings } from "./SkillsSettings.tsx";
import { RegistryBrowser } from "./RegistryBrowser.tsx";

type Tab = "plugins" | "skills" | "mcp";

/**
 * Plugins, skills and MCP servers, in one place.
 *
 * They were three separate pages in the sidebar, which put three names on something users have
 * one word for. A plugin *is* a bundle of skills and MCP servers — listing the container and
 * its two contents as siblings made them look like three competing mechanisms to choose
 * between, when the relationship is that one contains the others.
 *
 * The counts sit in the tabs because that is the question the page answers at a glance: how
 * much is installed, and of what.
 */
export function ExtensionsSettings() {
	const workspace = useApp((s) => s.workspace);
	const settings = useApp((s) => s.settings);
	const [tab, setTab] = useState<Tab>("plugins");
	const [query, setQuery] = useState("");
	const [browsing, setBrowsing] = useState(false);
	const [counts, setCounts] = useState({ plugins: 0, skills: 0 });
	const add = usePopover();

	useEffect(() => {
		void window.lyra.plugins.list(workspace?.path ?? "").then((scan) => {
			setCounts({ plugins: scan.plugins.length, skills: scan.skills.length });
		});
	}, [workspace?.path, settings?.disabledPlugins.length]);

	const tabs: { id: Tab; label: string; count: number; icon: typeof Blocks }[] = [
		{ id: "plugins", label: "插件", count: counts.plugins, icon: Blocks },
		{ id: "skills", label: "技能", count: counts.skills, icon: Sparkles },
		{ id: "mcp", label: "MCP", count: settings?.mcpServers.length ?? 0, icon: Cable },
	];

	return (
		<div className="flex min-h-0 flex-1 flex-col pt-8">
			<header className="flex shrink-0 items-center justify-between pb-5">
				<h1 className="text-display leading-tight font-semibold tracking-tight text-ink">插件</h1>

				<div className="flex shrink-0 items-center gap-2">
					<button
						type="button"
						onClick={() => setBrowsing(true)}
						className="flex h-[30px] items-center gap-1.5 rounded-lg border border-line px-3 text-label text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:border-ink-faint hover:text-ink"
					>
						<Store size={13} strokeWidth={1.8} />
						浏览市场
					</button>
					<button
						type="button"
						onClick={add.toggle}
						aria-haspopup="menu"
						aria-expanded={add.open}
						className="flex h-[30px] items-center gap-1.5 rounded-lg bg-ink px-3 text-label font-medium text-shell transition-opacity duration-[var(--ly-t-quick)] hover:opacity-90"
					>
						添加
						<ChevronDown size={13} strokeWidth={2} />
					</button>
				</div>
			</header>

			{add.open && (
				<Popover anchor={add.anchor} onClose={add.close} placement="bottom" align="end" width={210}>
					<div className="p-1">
						<MenuItem
							icon={<Store size={14} strokeWidth={1.8} />}
							onClick={() => {
								add.close();
								setBrowsing(true);
							}}
						>
							添加插件市场
						</MenuItem>
						<MenuItem
							icon={<Cable size={14} strokeWidth={1.8} />}
							onClick={() => {
								add.close();
								setTab("mcp");
							}}
						>
							添加 MCP 服务器
						</MenuItem>
						<MenuItem
							icon={<Plus size={14} strokeWidth={1.8} />}
							onClick={() => {
								add.close();
								void window.lyra.plugins.installExample("user", workspace?.path ?? "");
							}}
						>
							安装示例插件
						</MenuItem>
					</div>
				</Popover>
			)}

			{/* One row: what to look at, and what to look for. */}
			<div className="flex shrink-0 items-center gap-3 pb-5">
				<div className="flex items-center gap-1">
					{tabs.map((entry) => (
						<button
							key={entry.id}
							type="button"
							onClick={() => setTab(entry.id)}
							className={`flex h-[30px] items-center gap-1.5 rounded-lg px-3 text-label transition-colors duration-[var(--ly-t-quick)] ${
								tab === entry.id ? "bg-card-hover text-ink" : "text-ink-muted hover:bg-card-hover/60"
							}`}
						>
							<entry.icon size={13} strokeWidth={1.8} className="shrink-0" />
							{entry.label}
							<span className="text-ink-faint tabular-nums">{entry.count}</span>
						</button>
					))}
				</div>

				<div className="min-w-2 flex-1" />
				<SearchField
					size="comfortable"
					value={query}
					onChange={setQuery}
					placeholder="搜索"
					className="w-[220px]"
				/>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto pb-10">
				{tab === "plugins" && <PluginsSettings filter={query} />}
				{tab === "skills" && <SkillsSettings filter={query} />}
				{tab === "mcp" && <McpSettings filter={query} />}
			</div>

			{browsing && <RegistryBrowser onClose={() => setBrowsing(false)} />}
		</div>
	);
}
