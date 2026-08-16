/**
 * The navigation pane: what you can go to, and what you have been in.
 *
 * Only the pane itself lives here. Which sessions belong in the list and how they group under
 * projects is in `sidebar/grouping`, a project's own block is `sidebar/ProjectGroup`, and one
 * conversation is `sidebar/SessionRow` — each of which has hover and overlap rules worth stating
 * once rather than reading past on the way to the layout.
 */

import { AtSign, Bell, Clock, GitPullRequest, Search, Settings as SettingsIcon, SquarePen } from "lucide-react";
import { useMemo, useState } from "react";
import { useLayout } from "../layout.tsx";
import { useApp } from "../store.ts";
import { ScrollText } from "./ScrollText.tsx";
import { Scroller } from "./Scroller.tsx";
import { SearchField } from "./SearchField.tsx";
import { activeProviderLabel, groupSessions, listableSessions } from "./sidebar/grouping.ts";
import { ProjectGroup, SESSION_PAGE } from "./sidebar/ProjectGroup.tsx";

export function Sidebar() {
	const settings = useApp((s) => s.settings);
	const sessions = useApp((s) => s.sessions);
	const workspace = useApp((s) => s.workspace);
	const activeSessionId = useApp((s) => s.activeSessionId);
	const scratchRoots = useApp((s) => s.scratchRoots);
	const openSession = useApp((s) => s.openSession);
	const setSessionArchived = useApp((s) => s.setSessionArchived);
	const newSession = useApp((s) => s.newSession);
	const setView = useApp((s) => s.setView);
	const view = useApp((s) => s.view);
	/**
	 * As a drawer this pane covers the thing it navigates to, so anything that changes what is
	 * behind it also has to get out of the way. Pushed, `dismissNav` does nothing and the
	 * sidebar stays where the user put it.
	 */
	const { compact, dismissNav } = useLayout();

	const [query, setQuery] = useState("");
	const [searching, setSearching] = useState(false);
	/** How many rows each project is showing. Absent means the default five. */
	const [shown, setShown] = useState<Record<string, number>>({});

	const groups = useMemo(
		() => groupSessions(listableSessions(sessions, activeSessionId), settings?.projects ?? [], query, scratchRoots),
		[sessions, settings, query, activeSessionId, scratchRoots],
	);

	const groupProps = (path: string) => ({
		shown: shown[path] ?? SESSION_PAGE,
		onShowMore: () => setShown((prev) => ({ ...prev, [path]: (prev[path] ?? SESSION_PAGE) + SESSION_PAGE })),
		onCollapse: () => setShown((prev) => ({ ...prev, [path]: SESSION_PAGE })),
		activeSessionId,
		onOpenSession: (meta: Parameters<typeof openSession>[0]) => {
			void openSession(meta);
			dismissNav();
		},
		onArchiveSession: (meta: Parameters<typeof openSession>[0]) => void setSessionArchived(meta, true),
	});

	return (
		// No right border: the sidebar's own tint is what sets it apart from the column beside
		// it. A rule on top of that reads as a seam rather than a boundary.
		<div className="ly-sidebar-fill flex h-full w-full flex-col">
			<div className="h-[44px] shrink-0" />

			<div className="flex h-[34px] shrink-0 items-center justify-between px-4">
				{/*
				 * The app name, and nothing more. It used to open the project picker, which put the
				 * same control in two places and read as a dropdown over the whole window. Switching
				 * projects belongs on the composer's project chip, next to what it actually scopes.
				 */}
				<span className="text-title font-semibold tracking-tight text-ink">Lyra</span>
				<div className="flex items-center gap-0.5">
					<button
						type="button"
						data-ly-tip="搜索会话"
						aria-label="搜索会话"
						onClick={() => setSearching((v) => !v)}
						className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-card-hover hover:text-ink"
					>
						<Search size={15} strokeWidth={1.9} />
					</button>
					<button
						type="button"
						data-ly-tip="通知"
						aria-label="通知"
						className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-card-hover hover:text-ink"
					>
						<Bell size={15} strokeWidth={1.9} />
					</button>
				</div>
			</div>

			{searching && (
				<div className="px-3 pb-2">
					<SearchField
						autoFocus
						size="comfortable"
						value={query}
						onChange={setQuery}
						onEscape={() => setSearching(false)}
						placeholder="搜索会话…"
					/>
				</div>
			)}

			{/*
			 * Only 新对话 is pinned. The other three scroll away with the list.
			 *
			 * All four used to be fixed, which spent four rows of a narrow column on things that
			 * are visited a few times a day, and meant the sessions — the reason the pane exists —
			 * started a third of the way down and never got that space back however far you
			 * scrolled. Starting a conversation is the one action frequent enough to earn a
			 * permanent row; the rest are destinations, and a destination can be scrolled to.
			 */}
			<nav className={`flex flex-col pb-1 ${compact ? "px-3" : "px-2.5"}`}>
				<NavItem
					icon={<SquarePen size={15} strokeWidth={1.8} />}
					label="新对话"
					onClick={() => {
						void newSession();
						dismissNav();
					}}
				/>
			</nav>

			{/*
			 * Both ends soften.
			 *
			 * This was a hairline on top and nothing at the bottom, on the reasoning that the nav
			 * above and the settings row below are solid — content passes behind them rather than
			 * dissolving into them, so a fade would leave half-lit rows hanging off an opaque block.
			 * That was true of the fade we had, which painted a strip of `--color-sidebar` over the
			 * list; on a pane whose fill is translucent that strip is a grey film with an edge of its
			 * own, and the half-lit rows were it.
			 *
			 * A mask has no such problem — the rows genuinely thin out to nothing — and once they
			 * really do, the argument turns around: a hard rule at the top of a list that runs on
			 * says the list ended there. See `.ly-fade-y`.
			 */}
			<Scroller className="flex-1" contentClassName={`pb-2 ${compact ? "px-3" : "px-2.5"}`}>
				<div className="flex flex-col gap-[2px] pb-1">
					<NavItem
						active={view === "pull-requests"}
						icon={<GitPullRequest size={15} strokeWidth={1.8} />}
						label="拉取请求"
						onClick={() => {
							setView("pull-requests");
							dismissNav();
						}}
					/>
					<NavItem
						active={view === "scheduled"}
						icon={<Clock size={15} strokeWidth={1.8} />}
						label="已安排"
						onClick={() => {
							setView("scheduled");
							dismissNav();
						}}
					/>
					{/*
					 * The catalogue, not the settings pane it used to open.
					 *
					 * Clicking 插件 landed in 设置 › 插件, which is where you manage what you already
					 * have — so the one thing the sidebar entry could not do was show you what you
					 * could add. The two now split along that line: here to browse and install,
					 * settings to configure. The gear in this view's header is the way across.
					 */}
					<NavItem
						active={view === "plugins"}
						icon={<AtSign size={15} strokeWidth={1.8} />}
						label="插件"
						onClick={() => {
							setView("plugins");
							dismissNav();
						}}
					/>
				</div>

				{groups.pinned.length > 0 && <SectionLabel>置顶</SectionLabel>}
				{groups.pinned.map((group) => (
					<ProjectGroup
						key={group.path}
						group={group}
						active={workspace?.path === group.path}
						{...groupProps(group.path)}
					/>
				))}

				{groups.recent.length > 0 && <SectionLabel>最近</SectionLabel>}
				{groups.recent.map((group) => (
					<ProjectGroup
						key={group.path}
						group={group}
						active={workspace?.path === group.path}
						{...groupProps(group.path)}
					/>
				))}

				{groups.pinned.length === 0 && groups.recent.length === 0 && (
					<p className="px-2 py-6 text-center text-detail leading-relaxed text-ink-faint">
						还没有会话。
						<br />
						点击「新对话」开始。
					</p>
				)}
			</Scroller>

			{/*
			 * Padded container, rounded row — the same shape as every other item in this pane.
			 * As a full-bleed button its hover fill ran edge to edge and read as a different
			 * kind of control from the list it sits under.
			 */}
			<div className={`shrink-0 border-t border-line ${compact ? "p-3" : "p-2.5"}`}>
				<button
					type="button"
					onClick={() => {
						setView("settings");
						dismissNav();
					}}
					className={`ly-scroll flex w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover active:bg-elevated ${
						compact ? "h-[40px]" : "h-[34px]"
					}`}
				>
					<SettingsIcon size={16} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
					<ScrollText
						text={activeProviderLabel(settings?.providers ?? [])}
						className="min-w-0 flex-1 text-label text-ink"
					/>
					<span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-line text-caption text-ink-faint">
						?
					</span>
				</button>
			</div>
		</div>
	);
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return <div className="px-2 pt-4 pb-1.5 text-detail font-medium text-ink-faint">{children}</div>;
}

/**
 * A row in the nav, and — for the three that lead somewhere — whether you are there.
 *
 * Clicking these used to leave no trace: the view you had opened looked exactly like the one you
 * had not, so the only way to know where you were was to read the pane beside it. `active` is the
 * same treatment the settings nav already gives its own sections.
 *
 * Destinations sit in the muted tone and step up to full ink when current, which is what makes
 * the highlight read as "you are here" rather than as a hover that got stuck. 新对话 is not one
 * of them — it starts a conversation rather than leading anywhere, so it stays at full weight and
 * has no state to be in. `undefined` rather than `false` says that: not inactive, inapplicable.
 */
function NavItem({
	icon,
	label,
	onClick,
	active,
}: {
	icon: React.ReactNode;
	label: string;
	onClick?: () => void;
	active?: boolean;
}) {
	// A drawer is reached by pointing at it rather than by muscle memory, so its rows get the
	// taller touch-style hit area the reference mobile layout uses.
	const { compact } = useLayout();
	const tone =
		active === undefined
			? "text-ink hover:bg-card-hover"
			: active
				? "bg-card-hover text-ink"
				: "text-ink-muted hover:bg-card-hover/60 hover:text-ink";
	return (
		<button
			type="button"
			onClick={onClick}
			aria-current={active ? "page" : undefined}
			className={`flex w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors ${tone} ${
				compact ? "h-[40px] text-body" : "h-[31px] text-label"
			}`}
		>
			<span className={`shrink-0 ${active ? "text-ink" : "text-ink-muted"}`}>{icon}</span>
			{label}
		</button>
	);
}
