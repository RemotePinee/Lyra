/**
 * The plugin catalogue: what you could have, and what you already do.
 *
 * This is the browsing half of a subject that has two halves. It answers "what is out there and
 * what did I install" — a page of marks and one-line descriptions, laid out to be skimmed. The
 * other half is 设置 › 插件, which answers "what is this one doing": toggles, versions, the MCP
 * servers a bundle brought with it, where its directory is. The sidebar's 插件 used to go
 * straight there, which meant the first question had nowhere to be asked. The gear in the header
 * is the way from here to there, and it is deliberately the only one.
 *
 * Its header lives in the window's own 44px strip, level with the sidebar's controls, the same
 * way the pull request view does — see `PullRequestList` for why `no-drag` sits on the controls
 * and never on the row.
 */

import type { Skill } from "@lyra/core";
import { Blocks, Cable, ChevronDown, Plus, RefreshCw, Settings as SettingsIcon, Sparkles, Store } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useLayout } from "../layout.tsx";
import { useApp } from "../store.ts";
import { MenuItem, Popover, usePopover } from "./Popover.tsx";
import { Scroller } from "./Scroller.tsx";
import { SearchField } from "./SearchField.tsx";
import { PluginIcon } from "./settings/PluginIcon.tsx";
import { CatalogCard } from "./plugins/CatalogCard.tsx";
import { RegistrySources } from "./plugins/RegistrySources.tsx";
import { groupByCategory, UNFILED, useCatalog, type CatalogItem } from "./plugins/useCatalog.ts";
import { toolbarContentLeft } from "./WindowToolbar.tsx";

type Tab = "plugins" | "skills";
/**
 * Which half of the catalogue is on show.
 *
 * `public` is everything a registry offers, installed or not. `personal` is what only exists on
 * this machine — a directory somebody dropped in, or an example that was installed to be read.
 * The split is the one distinction the page can draw honestly: everything else it knows about a
 * bundle came out of the same two sources.
 */
type Scope = "public" | "personal";

export function PluginsView() {
	const { navOpen, nativeFullScreen } = useLayout();
	const toolbarLeft = toolbarContentLeft(navOpen, nativeFullScreen);
	const setView = useApp((s) => s.setView);
	const setSettingsSection = useApp((s) => s.setSettingsSection);
	const workspace = useApp((s) => s.workspace);

	const catalog = useCatalog();
	const [tab, setTab] = useState<Tab>("plugins");
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState<Scope | null>(null);
	const [sourcesOpen, setSourcesOpen] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const add = usePopover();

	const openSettings = () => {
		setView("settings");
		setSettingsSection("plugins");
	};

	const published = catalog.items.filter((item) => item.entry !== null);
	const personal = catalog.items.filter((item) => item.entry === null);
	/*
	 * Undecided until the user decides, then fixed.
	 *
	 * Landing on 公开 with no registries configured shows an empty page as the first thing this
	 * view ever does, which reads as broken rather than as unconfigured. Landing on whichever side
	 * has something in it costs nothing and is right in both directions — a fresh install has only
	 * personal bundles, a configured one has both.
	 */
	const current: Scope = scope ?? (published.length > 0 ? "public" : "personal");
	const shown = current === "public" ? published : personal;

	const needle = query.trim().toLowerCase();
	const filtered = useMemo(
		() =>
			needle
				? shown.filter((item) => `${item.name} ${item.id} ${item.description}`.toLowerCase().includes(needle))
				: shown,
		[shown, needle],
	);
	const groups = useMemo(() => groupByCategory(filtered), [filtered]);

	const installed = catalog.items.filter((item) => item.installed !== null);

	/*
	 * Clicking a mark in 已安装 scrolls to its card, which first requires the card to exist: it may
	 * be filtered out, or on the other side of 公开/个人. Clearing both and scrolling on the next
	 * commit is the whole of it — anything less makes the row a strip of pictures that sometimes
	 * does nothing when clicked, which is worse than a strip that never does.
	 */
	const [reveal, setReveal] = useState<string | null>(null);
	const body = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!reveal) return;
		body.current?.querySelector(`[data-item="${CSS.escape(reveal)}"]`)?.scrollIntoView({ block: "center" });
		setReveal(null);
	}, [reveal]);

	const revealItem = (item: CatalogItem) => {
		setQuery("");
		setScope(item.entry ? "public" : "personal");
		setTab("plugins");
		setReveal(item.key);
	};

	return (
		<div className="-mt-11 flex min-h-0 flex-1 flex-col">
			<header
				className="relative z-50 flex h-11 shrink-0 items-center gap-1 px-3"
				style={{ paddingLeft: toolbarLeft ? toolbarLeft : undefined }}
			>
				<div className="no-drag flex items-center gap-1">
					{(
						[
							{ id: "plugins" as const, label: "插件", icon: Blocks },
							{ id: "skills" as const, label: "技能", icon: Sparkles },
						] satisfies { id: Tab; label: string; icon: typeof Blocks }[]
					).map((entry) => (
						<button
							key={entry.id}
							type="button"
							onClick={() => setTab(entry.id)}
							className={`h-[26px] rounded-lg px-2.5 text-label transition-colors duration-[var(--ly-t-quick)] ${
								tab === entry.id ? "bg-card-hover text-ink" : "text-ink-muted hover:text-ink"
							}`}
						>
							{entry.label}
						</button>
					))}
				</div>

				{/* Everything between the tabs and the actions is the window's to drag. */}
				<div className="flex-1" />

				<div className="no-drag flex items-center gap-1">
					<HeaderButton label="重新读取" onClick={catalog.refresh}>
						<RefreshCw size={13.5} strokeWidth={1.8} className={catalog.loading ? "ly-spin" : undefined} />
					</HeaderButton>
					<HeaderButton label="插件设置" onClick={openSettings}>
						<SettingsIcon size={13.5} strokeWidth={1.8} />
					</HeaderButton>
					<button
						type="button"
						onClick={add.toggle}
						aria-haspopup="menu"
						aria-expanded={add.open}
						className="ml-1 flex h-[26px] items-center gap-1.5 rounded-lg bg-ink px-2.5 text-detail font-medium text-shell transition-opacity duration-[var(--ly-t-quick)] hover:opacity-90"
					>
						添加
						<ChevronDown size={12} strokeWidth={2} />
					</button>
				</div>
			</header>

			{add.open && (
				<Popover anchor={add.anchor} onClose={add.close} placement="bottom" align="end" width={200}>
					<div className="p-1">
						<MenuItem
							icon={<Store size={14} strokeWidth={1.8} />}
							onClick={() => {
								add.close();
								setSourcesOpen(true);
							}}
						>
							添加插件市场
						</MenuItem>
						<MenuItem
							icon={<Cable size={14} strokeWidth={1.8} />}
							onClick={() => {
								add.close();
								setView("settings");
								setSettingsSection("mcp");
							}}
						>
							添加 MCP 服务器
						</MenuItem>
						<MenuItem
							icon={<Plus size={14} strokeWidth={1.8} />}
							onClick={async () => {
								add.close();
								await window.lyra.plugins.installExample("user", workspace?.path ?? "");
								catalog.refresh();
							}}
						>
							安装示例插件
						</MenuItem>
					</div>
				</Popover>
			)}

			<Scroller className="flex-1" contentClassName="px-6 pb-16">
				{/* `@container`, so the grid answers to this column's width rather than the window's —
				    the sidebar and the panel both take from it. */}
				<div ref={body} className="@container mx-auto w-full max-w-[860px]">
					<h1 className="pt-6 text-display leading-tight font-semibold tracking-tight text-ink">
						{tab === "plugins" ? "插件" : "技能"}
					</h1>
					<p className="pt-2 pb-6 text-label leading-relaxed text-ink-muted">
						{tab === "plugins"
							? "一个插件是一组技能和 MCP 服务。装上之后，新开的会话就带着它们。"
							: "技能是一份写给 agent 的说明书。它们随插件一起来，也可以自己放一份。"}
					</p>

					<SearchField
						size="comfortable"
						value={query}
						onChange={setQuery}
						placeholder={tab === "plugins" ? "搜索插件" : "搜索技能"}
						className="w-full"
					/>

					{failure && (
						<p className="mt-4 rounded-[10px] border border-danger/35 bg-danger/6 px-3 py-2 text-detail leading-relaxed text-danger">
							{failure}
						</p>
					)}

					{tab === "plugins" ? (
						<>
							{installed.length > 0 && (
								<section className="pt-8">
									<div className="flex items-center gap-2 pb-3">
										<h2 className="text-body font-medium text-ink">已安装</h2>
										<span className="text-detail text-ink-faint tabular-nums">{installed.length}</span>
										<div className="flex-1" />
										<HeaderButton label="管理已安装的插件" onClick={openSettings}>
											<SettingsIcon size={13} strokeWidth={1.8} />
										</HeaderButton>
									</div>
									<div className="flex flex-wrap gap-2">
										{installed.map((item) => (
											<button
												key={item.key}
												type="button"
												data-ly-tip={item.installed?.enabled ? item.name : `${item.name}（已停用）`}
												aria-label={item.name}
												onClick={() => revealItem(item)}
												className={`flex h-[52px] w-[52px] items-center justify-center rounded-xl transition-[background-color,opacity] duration-[var(--ly-t-quick)] hover:bg-card-hover/60 ${
													item.installed?.enabled ? "" : "opacity-40"
												}`}
											>
												<PluginIcon
													name={item.name}
													logo={item.logo}
													brandColor={item.brandColor}
													size={34}
												/>
											</button>
										))}
									</div>
								</section>
							)}

							<div className="flex items-center gap-1 pt-8 pb-1">
								<ScopeTab active={current === "public"} count={published.length} onClick={() => setScope("public")}>
									公开
								</ScopeTab>
								<ScopeTab active={current === "personal"} count={personal.length} onClick={() => setScope("personal")}>
									个人
								</ScopeTab>
							</div>

							{catalog.errors.length > 0 && current === "public" && (
								<div className="mt-3 rounded-[10px] border border-accent/35 bg-accent/6 px-3 py-2">
									{catalog.errors.map((error) => (
										<p key={error.url} className="py-0.5 text-detail leading-relaxed text-accent">
											<span className="font-mono">{error.url}</span> — {error.message}
										</p>
									))}
								</div>
							)}

							{groups.length === 0 ? (
								<Empty
									scope={current}
									loading={catalog.loading}
									searching={needle.length > 0}
									sources={catalog.sources.length}
									onAddSource={() => setSourcesOpen(true)}
								/>
							) : (
								groups.map((group) => (
									<section key={group.category} className="pt-6">
										{/*
										 * A single unnamed group needs no heading — the page title already said
										 * what these are, and 其他 over the only section on screen names nothing.
										 */}
										{!(group.category === UNFILED && groups.length === 1) && (
											<h2 className="pb-1 text-body font-medium text-ink">
												{group.category === UNFILED ? "其他" : group.category}
											</h2>
										)}
										<div className="grid grid-cols-1 gap-x-4 @2xl:grid-cols-2">
											{group.items.map((item) => (
												<div key={item.key} data-item={item.key}>
													<CatalogCard
														item={item}
														onChanged={() => {
															setFailure(null);
															catalog.refresh();
														}}
														onError={setFailure}
													/>
												</div>
											))}
										</div>
									</section>
								))
							)}
						</>
					) : (
						<SkillList skills={catalog.skills} needle={needle} />
					)}

					{catalog.diagnostics.length > 0 && (
						<div className="mt-8 rounded-[10px] border border-accent/35 bg-accent/6 px-3 py-2">
							<p className="pb-1 text-detail font-medium text-accent">
								{catalog.diagnostics.length} 个插件读不出来
							</p>
							{catalog.diagnostics.map((diagnostic) => (
								<p key={diagnostic.path} className="py-0.5 text-detail leading-relaxed text-accent/85">
									<span className="font-mono">{diagnostic.path}</span> — {diagnostic.message}
								</p>
							))}
						</div>
					)}
				</div>
			</Scroller>

			{sourcesOpen && (
				<RegistrySources
					sources={catalog.sources}
					errors={catalog.errors}
					onClose={() => {
						setSourcesOpen(false);
						catalog.refresh();
					}}
				/>
			)}
		</div>
	);
}

function HeaderButton({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			data-ly-tip={label}
			aria-label={label}
			onClick={onClick}
			className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-ink-faint transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover hover:text-ink"
		>
			{children}
		</button>
	);
}

function ScopeTab({
	active,
	count,
	onClick,
	children,
}: {
	active: boolean;
	count: number;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			className={`flex h-[28px] items-center gap-1.5 rounded-lg px-2.5 text-label transition-colors duration-[var(--ly-t-quick)] ${
				active ? "bg-card-hover text-ink" : "text-ink-muted hover:text-ink"
			}`}
		>
			{children}
			<span className="text-detail text-ink-faint tabular-nums">{count}</span>
		</button>
	);
}

/**
 * Why there is nothing here, which is four different situations wearing the same blank page.
 *
 * Told apart because the useful next step differs every time: wait, clear the search, add a
 * registry, or accept that a configured registry is genuinely empty. A single "没有插件" would be
 * accurate in all four and actionable in none.
 */
function Empty({
	scope,
	loading,
	searching,
	sources,
	onAddSource,
}: {
	scope: Scope;
	loading: boolean;
	searching: boolean;
	sources: number;
	onAddSource: () => void;
}) {
	if (loading) {
		return <p className="py-16 text-center text-label text-ink-faint">读取中…</p>;
	}
	if (searching) {
		return <p className="py-16 text-center text-label text-ink-faint">没有匹配的插件</p>;
	}
	if (scope === "personal") {
		return (
			<p className="py-16 text-center text-label leading-relaxed text-ink-faint">
				这台机器上没有自己放的插件。
				<br />
				从「添加 › 安装示例插件」装一个，可以看看这个格式长什么样。
			</p>
		);
	}
	return (
		<div className="py-16 text-center">
			<p className="text-label leading-relaxed text-ink-faint">
				{sources === 0 ? "还没有添加任何插件市场。" : "这些市场里一个插件也没有。"}
			</p>
			<button
				type="button"
				onClick={onAddSource}
				className="mt-4 h-8 rounded-lg bg-ink px-3.5 text-label font-medium text-shell transition-opacity duration-[var(--ly-t-quick)] hover:opacity-90"
			>
				{sources === 0 ? "添加插件市场" : "管理插件市场"}
			</button>
		</div>
	);
}

/**
 * Every skill on this machine, whoever brought it.
 *
 * Flat rather than grouped by plugin: a skill is reached by name when the agent decides it is
 * relevant, and which bundle it arrived in is a fact about installation, not about use. The
 * source is on the row for the one moment it matters — working out which directory to edit.
 */
function SkillList({ skills, needle }: { skills: Skill[]; needle: string }) {
	const filtered = needle
		? skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(needle))
		: skills;

	if (filtered.length === 0) {
		return (
			<p className="py-16 text-center text-label text-ink-faint">
				{needle ? "没有匹配的技能" : "还没有技能。装一个插件，或者往技能目录里放一份 SKILL.md。"}
			</p>
		);
	}

	return (
		<div className="grid grid-cols-1 gap-x-4 pt-8 @2xl:grid-cols-2">
			{filtered.map((skill) => (
				<button
					key={`${skill.source}:${skill.name}`}
					type="button"
					data-ly-tip="打开目录"
					onClick={() => void window.lyra.system.openPath(skill.dir)}
					className="flex items-start gap-3 rounded-xl p-3 text-left transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover/60"
				>
					<PluginIcon name={skill.name} size={36} />
					<div className="min-w-0 flex-1 pt-0.5">
						<div className="flex items-center gap-2">
							<span className="truncate text-label font-medium text-ink">{skill.name}</span>
							{skill.pluginId && <span className="shrink-0 text-caption text-ink-faint">{skill.pluginId}</span>}
						</div>
						<p className="mt-0.5 line-clamp-2 text-detail leading-relaxed text-ink-muted">{skill.description}</p>
					</div>
				</button>
			))}
		</div>
	);
}
