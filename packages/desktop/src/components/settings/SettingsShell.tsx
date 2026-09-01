import {
	Anchor,
	Archive,
	ArrowLeft,
	BarChart3,
	Blocks,
	Bot,
	Camera,
	Database,
	FolderGit2,
	GitPullRequest,
	Globe,
	Info,
	Layers,
	Palette,
	Rocket,
	Search,
	Settings2,
	ShieldCheck,
	Smartphone,
	Sparkles,
	SquareTerminal,
	Wand2,
} from "lucide-react";
import { useEffect } from "react";
import { NavPane, useLayout } from "../../layout.tsx";
import type { SettingsSection } from "../../store.ts";
import { Scroller } from "../Scroller.tsx";
import { useApp } from "../../store.ts";
import { ToolbarButton } from "../WindowControls.tsx";
import { WindowActionButtons } from "../WindowActionButtons.tsx";
import { AgentsSettings } from "./AgentsSettings.tsx";
import { ArchivedSettings } from "./ArchivedSettings.tsx";
import { AboutSettings } from "./AboutSettings.tsx";
import { AppearanceSettings } from "./AppearanceSettings.tsx";
import { FormattingSettings } from "./FormattingSettings.tsx";
import { CommandsSettings } from "./CommandsSettings.tsx";
import { GeneralSettings } from "./GeneralSettings.tsx";
import { PersonalizationSettings } from "./PersonalizationSettings.tsx";
import { McpSettings } from "./McpSettings.tsx";
import { ModelSettings } from "./ModelSettings.tsx";
import { ExtensionsSettings } from "./ExtensionsSettings.tsx";
import { HooksSettings } from "./HooksSettings.tsx";
import { IndexSettings } from "./IndexSettings.tsx";
import { BrowserSettings } from "./BrowserSettings.tsx";
import { ScreenshotSettings } from "./ScreenshotSettings.tsx";
import { SkillsSettings } from "./SkillsSettings.tsx";
import { AccessSettings } from "./AccessSettings.tsx";
import { ForgeSettings } from "./ForgeSettings.tsx";
import { SearchSettings } from "./SearchSettings.tsx";
import { SyncSettings } from "./SyncSettings.tsx";
import { UsageSettings } from "./UsageSettings.tsx";
import { WorktreesSettings } from "./WorktreesSettings.tsx";

/**
 * Sections that fill the window and scroll their own panes.
 *
 * The model page is two lists side by side; a page-level scroller over the top would mean two
 * scrollbars for one screen and would carry each pane's header away from the rows it labels.
 */
const SELF_SCROLLING = new Set<SettingsSection>(["models"]);

const GROUPS: { label: string; items: { id: SettingsSection; label: string; icon: typeof Settings2 }[] }[] = [
	{
		label: "基础设置",
		items: [
			{ id: "general", label: "常规", icon: Settings2 },
			{ id: "appearance", label: "外观", icon: Palette },
			// Next to 外观 because they are asked about together, and separate because one changes
			// how code is drawn and the other changes what is written to disk.
			{ id: "formatting", label: "代码格式化", icon: Wand2 },
			{ id: "personalization", label: "个性化", icon: Sparkles },
			{ id: "models", label: "模型设置", icon: Layers },
			{ id: "forges", label: "代码托管", icon: GitPullRequest },
			{ id: "browser", label: "浏览器", icon: Globe },
		],
	},
	{
		label: "Agent 能力",
		items: [
			{ id: "plugins", label: "插件", icon: Blocks },
			{ id: "agents", label: "子智能体", icon: Bot },
			{ id: "commands", label: "命令", icon: SquareTerminal },
			{ id: "hooks", label: "钩子", icon: Anchor },
			{ id: "search", label: "网页搜索", icon: Search },
			{ id: "access", label: "访问授权", icon: ShieldCheck },
		],
	},
	{
		label: "数据与统计",
		items: [
			{ id: "index", label: "索引库", icon: Database },
			{ id: "sync", label: "移动端同步", icon: Smartphone },
			{ id: "usage", label: "使用统计", icon: BarChart3 },
		],
	},
	{
		label: "代码与版本控制",
		items: [
			{ id: "worktrees", label: "Worktrees", icon: FolderGit2 },
		],
	},
	{
		label: "关于与归档",
		items: [
			{ id: "about", label: "关于", icon: Info },
			{ id: "archived", label: "已归档的聊天", icon: Archive },
		],
	},
];

export function SettingsShell() {
	const section = useApp((s) => s.settingsSection);
	const setSection = useApp((s) => s.setSettingsSection);
	const setView = useApp((s) => s.setView);
	const { compact, navOpen, toggleNav, dismissNav, sidebarWidth, titlebar } = useLayout();

	const groups = GROUPS.map((group) => {
		if (group.label === "基础设置") {
			const items = [...group.items];
			// Insert screenshot settings into 基础设置
			items.splice(items.length - 1, 0, { id: "screenshot", label: "屏幕截图", icon: Camera });
			return { ...group, items };
		}
		return group;
	});

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
				event.preventDefault();
				toggleNav();
			} else if (event.key === "Escape" && compact && navOpen) {
				dismissNav();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [compact, navOpen, toggleNav, dismissNav]);

	const isDarwin = typeof navigator !== "undefined" && /Mac|iP(hone|od|ad)/.test(navigator.platform);

	return (
		/*
		 * The page is the palest surface here, as it is in the workspace.
		 *
		 * `bg-panel` put it within one step of the navigation beside it — 245 against 244 — so the
		 * two columns read as one undifferentiated field. The workspace already answers this: the
		 * nav is tinted and the thing you are working in is the plain page.
		 */
		<div className="relative flex h-full flex-col overflow-hidden bg-sidebar">
			{/* On Windows / Linux: Dedicated full-width immersive title bar for Settings */}
			{!isDarwin && (
				<header
					className="drag-region relative z-50 flex h-[38px] w-full shrink-0 select-none items-center justify-between bg-sidebar pl-2 pr-0 text-ink-muted text-xs"
				>
					<div className="no-drag flex items-center gap-1">
						<button
							type="button"
							aria-label={navOpen ? "收起设置导航" : "展开设置导航"}
							data-ly-tip={navOpen ? "收起设置导航" : "展开设置导航"}
							data-ly-tip-side="bottom"
							onClick={toggleNav}
							className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-card-hover hover:text-ink ${
								compact && navOpen ? "bg-card-hover text-ink" : "text-ink-muted"
							}`}
						>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
								<rect x="3" y="4" width="18" height="16" rx="2.5" />
								<line x1="9.5" y1="4" x2="9.5" y2="20" />
								<rect
									x="3"
									y="4"
									width="6.5"
									height="16"
									rx="2.5"
									fill="currentColor"
									stroke="none"
									className="transition-opacity duration-[var(--ly-t-base)]"
									opacity={navOpen ? 0.5 : 0}
								/>
							</svg>
						</button>
						<button
							type="button"
							onClick={() => {
								setView("chat");
								dismissNav();
							}}
							className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-sm text-ink-muted transition-colors hover:bg-card-hover hover:text-ink"
						>
							<ArrowLeft size={15} strokeWidth={1.8} />
							返回工作区
						</button>
					</div>

					{/* Center drag area */}
					<div className="flex-1 h-full" />

					{/* Right window action controls */}
					<WindowActionButtons />
				</header>
			)}

			<div className="relative flex flex-1 overflow-hidden bg-sidebar">
				<NavPane width={sidebarWidth} label="设置导航">
					{/* Same as the workspace sidebar: separated by its tint, not by a rule. */}
					<nav className="ly-sidebar-fill flex h-full w-full flex-col">
						{isDarwin && <div className="h-[44px] shrink-0" />}

						{/*
						 * On macOS: show the return button under the traffic light band.
						 * On Windows/Linux: the return action is already in the top AppHeader.
						 */}
						{isDarwin && (
							<div className={`pb-2 ${compact ? "px-3" : "px-2.5"}`}>
								<button
									type="button"
									onClick={() => {
										setView("chat");
										dismissNav();
									}}
									className={`flex w-full items-center gap-2.5 rounded-lg px-2 text-left text-label text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover hover:text-ink active:bg-elevated ${
										compact ? "h-[40px]" : "h-[32px]"
									}`}
								>
									<ArrowLeft size={15} strokeWidth={1.8} className="shrink-0" />
									返回工作区
								</button>
							</div>
						)}

						{/* Same as the workspace sidebar: both ends soften. */}
						<Scroller className="flex-1" contentClassName={`pb-3 ${compact ? "px-3" : "px-2.5"}`}>
							{groups.map((group) => (
								// Spaced for the same reason as the session list: adjacent filled rows
								// would otherwise merge into one block on hover.
								<div key={group.label} className="flex flex-col gap-[2px]">
									<div className={`px-2 pb-1 text-detail text-ink-faint ${isDarwin ? "pt-4" : "first:pt-1 pt-3"}`}>{group.label}</div>
									{group.items.map((item) => (
										<button
											key={item.id}
											type="button"
											onClick={() => {
												setSection(item.id);
												dismissNav();
											}}
											className={`flex w-full items-center gap-2.5 rounded-lg px-2 text-left text-label transition-colors ${
												compact ? "h-[40px]" : "h-[32px]"
											} ${
												section === item.id
													? "bg-card-hover text-ink"
													: "text-ink-muted hover:bg-card-hover/60 hover:text-ink"
											}`}
										>
											<item.icon size={15} strokeWidth={1.8} className="shrink-0" />
											{item.label}
										</button>
									))}
								</div>
							))}
						</Scroller>

						<div className={`pb-3 ${compact ? "px-3" : "px-2.5"}`}>
							{/* The dashed edge marks it as the odd one out; the fill on hover keeps it
							    behaving like the rest of the pane. */}
							<button
								type="button"
								onClick={() => {
									setSection("models");
									dismissNav();
								}}
								className="flex h-[36px] w-full items-center justify-center gap-2 rounded-lg border border-dashed border-line text-label text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover hover:text-ink active:bg-elevated"
							>
								<Rocket size={14} strokeWidth={1.8} />
								引导
							</button>
						</div>
					</nav>
				</NavPane>

				<main
					className={`relative flex min-w-0 flex-1 flex-col bg-shell ${
						!isDarwin ? "overflow-hidden rounded-tl-xl border-t border-l border-line-soft shadow-xs" : "ly-opaque"
					}`}
				>
					{isDarwin && <div className="h-[44px] shrink-0" />}
					{/*
					 * Most sections are a column of settings and scroll as one page. A few are
					 * two-pane layouts whose halves scroll independently — putting those inside a page
					 * scroller as well would give the window two nested scrollbars for one screen, and
					 * the outer one would move the pane headers out from over their own content.
					 */}
					{SELF_SCROLLING.has(section) ? (
						<div className={`mx-auto flex min-h-0 w-full max-w-[900px] flex-1 flex-col py-6 ${compact ? "px-4" : "px-9"}`}>
							<SectionBody section={section} />
						</div>
					) : (
						<Scroller className="flex-1">
							<div className={`mx-auto w-full max-w-[900px] py-8 ${compact ? "px-4" : "px-9"}`}>
								<SectionBody section={section} />
							</div>
						</Scroller>
					)}
				</main>

				{/* On macOS: render native traffic light neighbour buttons */}
				{isDarwin && (
					<div className="drag-region absolute inset-x-0 top-0 z-40 h-[44px]">
						<div className="no-drag absolute top-0 flex h-[44px] items-center gap-0.5" style={{ left: titlebar.start }}>
							<ToolbarButton
								label={navOpen ? "隐藏设置导航 ⌘B" : "显示设置导航 ⌘B"}
								onClick={toggleNav}
								active={compact && navOpen}
							>
								<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
									<rect x="3" y="4" width="18" height="16" rx="2.5" />
									<line x1="9.5" y1="4" x2="9.5" y2="20" />
									<rect
										x="3"
										y="4"
										width="6.5"
										height="16"
										rx="2.5"
										fill="currentColor"
										stroke="none"
										className="transition-opacity duration-[var(--ly-t-base)]"
										opacity={navOpen ? 0.5 : 0}
									/>
								</svg>
							</ToolbarButton>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

function SectionBody({ section }: { section: SettingsSection }) {
	switch (section) {
		case "general":
			return <GeneralSettings />;
		case "appearance":
			return <AppearanceSettings />;
		case "formatting":
			return <FormattingSettings />;
		case "personalization":
			return <PersonalizationSettings />;
		case "models":
			return <ModelSettings />;
		case "skills":
			return <SkillsSettings />;
		case "agents":
			return <AgentsSettings />;
		case "mcp":
			return <McpSettings />;
		case "plugins":
			return <ExtensionsSettings />;
		case "hooks":
			return <HooksSettings />;
		case "index":
			return <IndexSettings />;
		case "browser":
			return <BrowserSettings />;
		case "screenshot":
			return <ScreenshotSettings />;
		case "commands":
			return <CommandsSettings />;
		case "search":
			return <SearchSettings />;
		case "access":
			return <AccessSettings />;
		case "forges":
			return <ForgeSettings />;
		case "sync":
			return <SyncSettings />;
		case "usage":
			return <UsageSettings />;
		case "worktrees":
			return <WorktreesSettings />;
		case "about":
			return <AboutSettings />;
		case "archived":
			return <ArchivedSettings />;
		default:
			return <GeneralSettings />;
	}
}
