/**
 * One plugin, at length.
 *
 * The grid answers "which one"; this answers "what is in it, and do I want it". Those need
 * different amounts of room, which is why it is a page rather than a popover — a bundle that
 * brings four skills and two MCP servers has a real inventory, and an inventory that has to be
 * scrolled inside a floating card is an inventory nobody reads.
 *
 * How much there is to say depends on which side of installation you are on. A bundle on disk
 * has a manifest: every skill it carries, every server it declares, what it says about itself at
 * length. One that is still in a registry has a name, a line, and a git URL — so the page shows
 * what it has and does not pad the rest out with empty headings.
 *
 * The skills and servers are listed, not switched. There is one switch in this app and it is the
 * plugin — `disabledPlugins` is the whole of the persistence — so a toggle on each row would be a
 * control that reports a state it cannot hold. Listing them says what arrives with the bundle,
 * which is the question being asked before installing it.
 */

import type { McpServerConfig, Plugin } from "@lyra/core";
import {
	ArrowUpRight,
	Cable,
	ChevronRight,
	Download,
	ExternalLink,
	FolderOpen,
	Loader2,
	Sparkles,
	Trash2,
} from "lucide-react";
import { useState } from "react";

import { useApp } from "../../store.ts";
import { Scroller } from "../Scroller.tsx";
import { PluginIcon } from "../settings/PluginIcon.tsx";
import type { CatalogItem } from "./useCatalog.ts";

export function PluginDetail({
	item,
	onBack,
	onChanged,
	onError,
	onTry,
}: {
	item: CatalogItem;
	onBack: () => void;
	onChanged: () => void;
	onError: (message: string) => void;
	/** Starts a conversation with this prompt already in the composer. */
	onTry: (prompt: string) => void;
}) {
	const settings = useApp((s) => s.settings);
	const saveSettings = useApp((s) => s.saveSettings);
	const [busy, setBusy] = useState<"install" | "uninstall" | null>(null);

	const plugin = item.installed;
	const ui = plugin?.manifest.interface;
	const prompts = ui?.defaultPrompt ?? [];
	const installed = plugin !== null;

	const install = async () => {
		if (!item.entry) return;
		setBusy("install");
		const result = await window.lyra.plugins.installFromRegistry(item.entry);
		setBusy(null);
		if (result.ok) onChanged();
		else onError(`${item.name}：${result.message}`);
	};

	const uninstall = async () => {
		setBusy("uninstall");
		await window.lyra.plugins.uninstall(item.id);
		setBusy(null);
		onBack();
		onChanged();
	};

	/*
	 * `*` in `disabledPlugins` means "none of them", whoever wrote it there.
	 *
	 * Switching this one on has to clear that as well, or the control reports a change and
	 * produces none. Turning the wildcard off means naming what it stood for — everything else
	 * currently on disk.
	 */
	const toggleEnabled = () => {
		if (!settings || !plugin) return;
		const disabled = new Set(settings.disabledPlugins);
		const turningOn = !plugin.enabled;
		if (disabled.has("*") && turningOn) disabled.delete("*");
		if (turningOn) disabled.delete(plugin.id);
		else disabled.add(plugin.id);
		void saveSettings({ ...settings, disabledPlugins: [...disabled] });
		onChanged();
	};

	const website = ui?.websiteURL ?? plugin?.manifest.homepage ?? item.entry?.homepage;
	const developer =
		ui?.developerName ??
		(typeof plugin?.manifest.author === "string" ? plugin.manifest.author : plugin?.manifest.author?.name) ??
		item.entry?.author;

	return (
		<div className="-mt-11 flex min-h-0 flex-1 flex-col">
			<header className="relative z-50 flex h-11 shrink-0 items-center gap-1 px-3">
				<nav className="no-drag flex items-center gap-1 text-label">
					<button
						type="button"
						onClick={onBack}
						className="rounded-lg px-2 py-1 text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:text-ink"
					>
						插件
					</button>
					<ChevronRight size={13} strokeWidth={1.8} className="shrink-0 text-ink-faint" />
					<span className="max-w-[280px] truncate px-1 text-ink">{item.name}</span>
				</nav>

				<div className="flex-1" />

				{website && (
					<div className="no-drag flex items-center gap-1">
						<button
							type="button"
							data-ly-tip="打开主页"
							aria-label="打开主页"
							onClick={() => void window.lyra.system.openExternal(website)}
							className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-ink-faint transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover hover:text-ink"
						>
							<ExternalLink size={13.5} strokeWidth={1.8} />
						</button>
					</div>
				)}
			</header>

			<Scroller className="flex-1" contentClassName="px-6 pb-16">
				<div className="mx-auto w-full max-w-[720px]">
					<div className="pt-4">
						<PluginIcon
							name={item.name}
							id={item.id}
							logo={item.logo}
							brandColor={item.brandColor}
							category={item.category}
							size={64}
						/>
					</div>

					<div className="flex items-start gap-3 pt-5">
						<div className="min-w-0 flex-1">
							<h1 className="text-heading leading-tight font-semibold tracking-tight text-ink">{item.name}</h1>
							<p className="pt-1 text-label leading-relaxed text-ink-muted">
								{item.description || "（没有描述）"}
							</p>
						</div>

						<div className="flex shrink-0 items-center gap-1.5 pt-1">
							{installed ? (
								<>
									<button
										type="button"
										onClick={toggleEnabled}
										className="flex h-[30px] items-center rounded-lg border border-line px-3 text-detail text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:border-ink-faint hover:text-ink"
									>
										{plugin.enabled ? "停用" : "启用"}
									</button>
									<button
										type="button"
										data-ly-tip={plugin.source === "workspace" ? "项目里的插件，从项目目录里删" : "卸载"}
										aria-label="卸载"
										disabled={busy !== null || plugin.source === "workspace"}
										onClick={() => void uninstall()}
										className="flex h-[30px] w-[30px] items-center justify-center rounded-lg text-ink-faint transition-colors duration-[var(--ly-t-quick)] hover:bg-danger/10 hover:text-danger disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-faint"
									>
										{busy === "uninstall" ? (
											<Loader2 size={13} strokeWidth={2} className="ly-spin" />
										) : (
											<Trash2 size={13} strokeWidth={1.8} />
										)}
									</button>
								</>
							) : (
								item.entry && (
									<button
										type="button"
										disabled={busy !== null}
										onClick={() => void install()}
										className="flex h-[30px] items-center gap-1.5 rounded-lg bg-ink px-3.5 text-detail font-medium text-shell transition-opacity duration-[var(--ly-t-quick)] hover:opacity-90 disabled:opacity-50"
									>
										{busy === "install" ? (
											<Loader2 size={12.5} strokeWidth={2} className="ly-spin" />
										) : (
											<Download size={12.5} strokeWidth={1.9} />
										)}
										安装
									</button>
								)
							)}
						</div>
					</div>

					{/*
					 * The examples, on the bundle's own colour.
					 *
					 * Only for something installed and switched on: these are buttons that start a
					 * conversation, and offering to run a prompt against a plugin that is not loaded
					 * would produce a session that silently lacks the thing being demonstrated.
					 */}
					{prompts.length > 0 && installed && plugin.enabled && (
						<section
							style={{
								background: item.brandColor
									? `linear-gradient(135deg, color-mix(in srgb, ${item.brandColor} 22%, transparent), color-mix(in srgb, ${item.brandColor} 8%, transparent))`
									: undefined,
							}}
							className={`mt-7 flex flex-col gap-2 rounded-2xl p-5 ${item.brandColor ? "" : "bg-card-hover/50"}`}
						>
							{prompts.slice(0, 4).map((prompt, index) => (
								<button
									key={prompt}
									type="button"
									onClick={() => onTry(prompt)}
									// Staggered indents so three stacked bubbles read as a conversation, not a list.
									style={{ marginLeft: `${[0, 8, 4, 12][index % 4]}%`, marginRight: `${[12, 4, 8, 0][index % 4]}%` }}
									className="group/prompt flex items-center gap-2.5 rounded-xl bg-shell/85 px-3.5 py-2.5 text-left text-label text-ink shadow-sm transition-[background-color,transform] duration-[var(--ly-t-quick)] hover:bg-shell"
								>
									<PluginIcon
										name={item.name}
										id={item.id}
										logo={item.logo}
										brandColor={item.brandColor}
										category={item.category}
										size={16}
									/>
									<span className="min-w-0 flex-1">{prompt}</span>
									<ArrowUpRight
										size={14}
										strokeWidth={2}
										className="shrink-0 text-ink-faint transition-colors duration-[var(--ly-t-quick)] group-hover/prompt:text-ink"
									/>
								</button>
							))}
						</section>
					)}

					{ui?.longDescription && (
						<p className="pt-7 text-label leading-relaxed whitespace-pre-line text-ink-muted">
							{ui.longDescription}
						</p>
					)}

					{plugin && plugin.mcpServers.length > 0 && (
						<Section title="MCP 服务器" count={plugin.mcpServers.length}>
							{plugin.mcpServers.map((server) => (
								<ServerRow key={server.id} server={server} />
							))}
						</Section>
					)}

					{plugin && plugin.skills.length > 0 && (
						<Section title="技能" count={plugin.skills.length}>
							{plugin.skills.map((skill) => (
								<div key={skill.name} className="flex items-start gap-3 py-2.5">
									<Sparkles size={15} strokeWidth={1.8} className="mt-0.5 shrink-0 text-violet" />
									<div className="min-w-0 flex-1">
										<div className="text-label text-ink">{skill.name}</div>
										<p className="mt-0.5 text-detail leading-relaxed text-ink-muted">{skill.description}</p>
									</div>
								</div>
							))}
						</Section>
					)}

					<Section title="信息">
						{developer && <InfoRow label="开发者">{developer}</InfoRow>}
						{item.category !== " unfiled" && <InfoRow label="类别">{item.category}</InfoRow>}
						{plugin?.manifest.version && <InfoRow label="版本">{plugin.manifest.version}</InfoRow>}
						{plugin?.manifest.license && <InfoRow label="许可">{plugin.manifest.license}</InfoRow>}
						{item.from && <InfoRow label="来源">{item.from}</InfoRow>}
						{item.entry?.repository && (
							<InfoRow label="仓库">
								<button
									type="button"
									onClick={() => void window.lyra.system.openExternal(repoUrl(item.entry!.repository))}
									className="inline-flex items-center gap-1 font-mono text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:text-ink"
								>
									{item.entry.repository.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")}
									<ExternalLink size={11} strokeWidth={1.9} />
								</button>
							</InfoRow>
						)}
						{website && (
							<InfoRow label="网站">
								<button
									type="button"
									onClick={() => void window.lyra.system.openExternal(website)}
									className="inline-flex items-center gap-1 text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:text-ink"
								>
									{website.replace(/^https?:\/\//, "")}
									<ExternalLink size={11} strokeWidth={1.9} />
								</button>
							</InfoRow>
						)}
						{plugin && (
							<InfoRow label="目录">
								<button
									type="button"
									onClick={() => void window.lyra.system.openPath(plugin.dir)}
									className="inline-flex items-center gap-1 font-mono text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:text-ink"
								>
									{plugin.dir.replace(/^\/Users\/[^/]+/, "~")}
									<FolderOpen size={11} strokeWidth={1.9} />
								</button>
							</InfoRow>
						)}
					</Section>

					{/*
					 * Said once, at the bottom, for anything not yet on disk.
					 *
					 * Installing is a `git clone` of somebody else's repository. The index this came
					 * from is a list, not a review — and the moment to say so is while looking at the
					 * install button, not in a README nobody opened.
					 */}
					{!installed && item.entry && (
						<p className="pt-8 text-detail leading-relaxed text-ink-faint">
							安装会把这个仓库克隆到本地插件目录。市场只是一份索引，不做审核——装之前请自己看一眼它的仓库。
							{plugin === null && item.entry.path
								? "它声明的 MCP 服务会随插件一起启用，那条命令会在你的机器上以你的权限运行。"
								: ""}
						</p>
					)}
				</div>
			</Scroller>
		</div>
	);
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
	return (
		<section className="pt-8">
			<div className="flex items-center gap-2 border-b border-line-soft pb-2">
				<h2 className="text-body font-medium text-ink">{title}</h2>
				{count !== undefined && <span className="text-detail text-ink-faint tabular-nums">{count}</span>}
			</div>
			<div className="pt-1">{children}</div>
		</section>
	);
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-baseline gap-4 py-1.5 text-label">
			<span className="w-[72px] shrink-0 text-ink-faint">{label}</span>
			<span className="min-w-0 flex-1 break-all text-ink-muted">{children}</span>
		</div>
	);
}

/**
 * One declared server, and how it would be started.
 *
 * The command is the useful part: it is what will run on this machine if the server is switched
 * on, and reading it is the only way to know whether that is `npx` fetching a package or a binary
 * you already have. Shown as-is, in mono, rather than summarised.
 */
function ServerRow({ server }: { server: McpServerConfig }) {
	const how =
		server.transport === "stdio"
			? `${server.command} ${(server.args ?? []).join(" ")}`.trim()
			: (server.url ?? "");

	return (
		<div className="flex items-start gap-3 py-2.5">
			<Cable size={15} strokeWidth={1.8} className="mt-0.5 shrink-0 text-info" />
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="text-label text-ink">{server.name}</span>
					<span className="text-caption text-ink-faint">{server.transport}</span>
					{!server.enabled && <span className="text-caption text-ink-faint">默认关闭</span>}
				</div>
				{how && <p className="mt-0.5 truncate font-mono text-detail text-ink-muted">{how}</p>}
			</div>
		</div>
	);
}

/** `git@github.com:owner/repo.git` is not something a browser can open. */
function repoUrl(repository: string): string {
	const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(repository);
	return ssh ? `https://${ssh[1]}/${ssh[2]}` : repository.replace(/\.git$/, "");
}

/** Kept in step with `UNFILED` in useCatalog, where the sentinel is defined. */
export type { Plugin };
