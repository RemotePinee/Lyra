import type { SessionMeta } from "@deepwise/core";
import {
	Archive,
	AtSign,
	Bell,
	Clock,
	Folder,
	GitPullRequest,
	Search,
	Settings as SettingsIcon,
	SquarePen,
} from "lucide-react";
import { useMemo, useState } from "react";
import { ScrollText } from "./ScrollText.tsx";
import { usePopover } from "./Popover.tsx";
import { ProjectMenu } from "./modals/ProjectMenu.tsx";
import { useLayout } from "../layout.tsx";
import { Scroller } from "./Scroller.tsx";
import { SearchField } from "./SearchField.tsx";
import { useApp } from "../store.ts";

const COLLAPSED_SESSION_COUNT = 5;

export function Sidebar() {
	const settings = useApp((s) => s.settings);
	const sessions = useApp((s) => s.sessions);
	const workspace = useApp((s) => s.workspace);
	const activeSessionId = useApp((s) => s.activeSessionId);
	const openSession = useApp((s) => s.openSession);
	const setSessionArchived = useApp((s) => s.setSessionArchived);
	const newSession = useApp((s) => s.newSession);
	const setView = useApp((s) => s.setView);
	/**
	 * As a drawer this pane covers the thing it navigates to, so anything that changes what is
	 * behind it also has to get out of the way. Pushed, `dismissNav` does nothing and the
	 * sidebar stays where the user put it.
	 */
	const { compact, dismissNav } = useLayout();

	const [query, setQuery] = useState("");
	const [searching, setSearching] = useState(false);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});

	/*
	 * Two exclusions.
	 *
	 * Archived sessions live in settings — that is the whole point of archiving them. Empty
	 * ones are not conversations yet: they have no title and nothing to return to, so a row
	 * for one is a row that cannot be usefully clicked. The active session is exempt, because
	 * the conversation you are in the middle of starting must stay visible and selected while
	 * its first message is still in flight.
	 */
	const groups = useMemo(
		() =>
			groupSessions(
				sessions.filter((s) => !s.archived && (s.messageCount > 0 || s.id === activeSessionId)),
				settings?.projects ?? [],
				query,
			),
		[sessions, settings, query, activeSessionId],
	);

	return (
		// No right border: the sidebar's own tint is what sets it apart from the column beside
		// it. A rule on top of that reads as a seam rather than a boundary.
		<div className="dw-sidebar-fill flex h-full w-full flex-col">
			<div className="h-[44px] shrink-0" />

			<div className="flex h-[34px] shrink-0 items-center justify-between px-4">
				{/*
				 * The app name, and nothing more. It used to open the project picker, which put the
				 * same control in two places and read as a dropdown over the whole window. Switching
				 * projects belongs on the composer's project chip, next to what it actually scopes.
				 */}
				<span className="text-[16px] font-semibold tracking-tight text-ink">DeepWise</span>
				<div className="flex items-center gap-0.5">
					<button
						type="button"
						title="搜索会话"
						onClick={() => setSearching((v) => !v)}
						className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-card-hover hover:text-ink"
					>
						<Search size={15} strokeWidth={1.9} />
					</button>
					<button
						type="button"
						title="通知"
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

			<nav className={`flex flex-col gap-[2px] pb-1 ${compact ? "px-3" : "px-2.5"}`}>
				<NavItem
					icon={<SquarePen size={15} strokeWidth={1.8} />}
					label="新对话"
					onClick={() => {
						void newSession();
						dismissNav();
					}}
				/>
				<NavItem
					icon={<GitPullRequest size={15} strokeWidth={1.8} />}
					label="拉取请求"
					onClick={() => {
						setView("pull-requests");
						dismissNav();
					}}
				/>
				<NavItem
					icon={<Clock size={15} strokeWidth={1.8} />}
					label="已安排"
					onClick={() => {
						setView("scheduled");
						dismissNav();
					}}
				/>
				<NavItem
					icon={<AtSign size={15} strokeWidth={1.8} />}
					label="插件"
					onClick={() => {
						setView("settings");
						useApp.getState().setSettingsSection("plugins");
						dismissNav();
					}}
				/>
			</nav>

			<Scroller
				className="flex-1"
				divider
				contentClassName={`pb-2 ${compact ? "px-3" : "px-2.5"}`}
				fadeColor="var(--color-sidebar)"
			>
				{groups.pinned.length > 0 && <SectionLabel>置顶</SectionLabel>}
				{groups.pinned.map((group) => (
					<ProjectGroup
						key={group.path}
						group={group}
						active={workspace?.path === group.path}
						activeSessionId={activeSessionId}
						expanded={expanded[group.path] === true}
						onToggleExpand={() => setExpanded((prev) => ({ ...prev, [group.path]: !prev[group.path] }))}
						onOpenSession={(meta) => {
							void openSession(meta);
							dismissNav();
						}}
						onArchiveSession={(meta) => void setSessionArchived(meta, true)}
					/>
				))}

				{groups.recent.length > 0 && <SectionLabel>最近</SectionLabel>}
				{groups.recent.map((group) => (
					<ProjectGroup
						key={group.path}
						group={group}
						active={workspace?.path === group.path}
						activeSessionId={activeSessionId}
						expanded={expanded[group.path] === true}
						onToggleExpand={() => setExpanded((prev) => ({ ...prev, [group.path]: !prev[group.path] }))}
						onOpenSession={(meta) => {
							void openSession(meta);
							dismissNav();
						}}
						onArchiveSession={(meta) => void setSessionArchived(meta, true)}
					/>
				))}

				{groups.pinned.length === 0 && groups.recent.length === 0 && (
					<p className="px-2 py-6 text-center text-[12px] leading-relaxed text-ink-faint">
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
					className={`dw-scroll flex w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors duration-150 hover:bg-card-hover active:bg-elevated ${
						compact ? "h-[40px]" : "h-[34px]"
					}`}
				>
					<SettingsIcon size={16} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
					<ScrollText
						text={activeProviderLabel(settings?.providers ?? [])}
						className="min-w-0 flex-1 text-[12.5px] text-ink"
					/>
					<span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-line text-[9px] text-ink-faint">
						?
					</span>
				</button>
			</div>
		</div>
	);
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return <div className="px-2 pt-4 pb-1.5 text-[11.5px] font-medium text-ink-faint">{children}</div>;
}

function NavItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick?: () => void }) {
	// A drawer is reached by pointing at it rather than by muscle memory, so its rows get the
	// taller touch-style hit area the reference mobile layout uses.
	const { compact } = useLayout();
	return (
		<button
			type="button"
			onClick={onClick}
			className={`flex w-full items-center gap-2.5 rounded-lg px-2 text-left text-ink transition-colors hover:bg-card-hover ${
				compact ? "h-[40px] text-[13.5px]" : "h-[31px] text-[13px]"
			}`}
		>
			<span className="shrink-0 text-ink-muted">{icon}</span>
			{label}
		</button>
	);
}

interface Group {
	path: string;
	name: string;
	sessions: SessionMeta[];
}

function ProjectGroup({
	group,
	active,
	activeSessionId,
	expanded,
	onToggleExpand,
	onOpenSession,
	onArchiveSession,
}: {
	group: Group;
	active: boolean;
	activeSessionId: string | null;
	expanded: boolean;
	onToggleExpand: () => void;
	onOpenSession: (meta: SessionMeta) => void;
	onArchiveSession: (meta: SessionMeta) => void;
}) {
	const openWorkspace = useApp((s) => s.openWorkspace);
	const { compact, dismissNav } = useLayout();
	const menu = usePopover();
	const visible = expanded ? group.sessions : group.sessions.slice(0, COLLAPSED_SESSION_COUNT);
	const hidden = group.sessions.length - visible.length;

	return (
		/*
		 * The rows are spaced rather than stacked flush. Their hover and selected states are
		 * filled rounded rectangles, and with no gap two adjacent ones merge into a single
		 * block — you can no longer tell where one session ends and the next begins.
		 */
		<div className={`mb-2 flex flex-col ${compact ? "gap-[5px]" : "gap-[4px]"}`}>
			{/* Same hover-owner arrangement as the session rows: the fill belongs to the row so
			    reaching for the menu button does not drop it. */}
			<div
				className={`dw-scroll group/project relative rounded-lg transition-colors duration-150 ${
					active ? "bg-card-hover" : "hover:bg-card-hover active:bg-elevated"
				}`}
				onContextMenu={(event) => {
					event.preventDefault();
					// At the cursor: right-click acts on the row as a whole, so there is no one
					// control for the menu to hang off.
					menu.openAtPoint(event);
				}}
			>
				<button
					type="button"
					onClick={() => {
						void openWorkspace(group.path);
						dismissNav();
					}}
					className={`flex w-full items-center gap-2.5 rounded-lg pr-2 pl-2 text-left text-[13px] transition-colors duration-150 ${
						compact ? "h-[40px]" : "h-[31px]"
					} ${active ? "text-ink" : "text-ink group-hover/project:text-ink"}`}
				>
					<Folder size={15} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
					<ScrollText text={group.name} className="min-w-0 flex-1" />
				</button>

				<span
					className="pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-r-lg pr-1.5 pl-8 opacity-0 transition-opacity duration-150 group-hover/project:opacity-100"
					style={{
						background:
							"linear-gradient(to right, transparent 0%, var(--color-card-hover) 55%, var(--color-card-hover) 100%)",
					}}
				>
					<button
						type="button"
						title="项目操作"
						aria-label={`「${group.name}」的项目操作`}
						aria-haspopup="menu"
						onClick={menu.toggle}
						className="pointer-events-auto rounded p-1 text-ink-faint transition-colors duration-150 hover:text-ink"
					>
						<SquarePen size={12.5} strokeWidth={1.8} />
					</button>
				</span>
			</div>

			{menu.open && (
				<ProjectMenu anchor={menu.anchor} path={group.path} name={group.name} onClose={menu.close} />
			)}

			{visible.map((session) => (
				/*
				 * The row, not the button inside it, owns the hover state.
				 *
				 * The delete affordance is a sibling laid over the button's right-hand end, so a
				 * pointer sitting there is outside the button — hanging `hover:` on the button
				 * meant the fill and the text colour dropped out the moment you reached for the
				 * icon, while the icon itself (keyed off the row) stayed. Moving both to the row
				 * makes the whole strip one hover target.
				 */
				<div
					key={session.id}
					className={`dw-scroll group/session relative rounded-lg transition-colors duration-150 active:bg-elevated ${
						activeSessionId === session.id ? "bg-card-hover" : "hover:bg-card-hover"
					}`}
				>
					<button
						type="button"
						onClick={() => onOpenSession(session)}
						className={`flex w-full items-center rounded-lg pr-2 pl-9 text-left text-[12.5px] transition-colors duration-150 ${
							compact ? "h-[34px]" : "h-[27px]"
						} ${activeSessionId === session.id ? "text-ink" : "text-ink-muted group-hover/session:text-ink"}`}
					>
						<ScrollText text={session.title} className="min-w-0 flex-1" />
					</button>
					{/*
					 * The delete button rides on a gradient rather than sitting bare on top of the
					 * title — otherwise a long name runs straight under the icon and both become
					 * unreadable. The gradient reaches full opacity before the icon starts, so
					 * nothing shows through it, and it gives the scrolling text somewhere to go.
					 *
					 * The strip never takes pointer events; only the button does. Anything wider
					 * would shadow the row button and cost it its hover.
					 */}
					<span
						className="pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-r-lg pr-1.5 pl-10 opacity-0 transition-opacity duration-150 group-hover/session:opacity-100"
						style={{
							background:
								"linear-gradient(to right, transparent 0%, var(--color-card-hover) 55%, var(--color-card-hover) 100%)",
						}}
					>
						<button
							type="button"
							title="归档会话"
							aria-label={`归档会话「${session.title}」`}
							onClick={() => onArchiveSession(session)}
							className="pointer-events-auto rounded p-1 text-ink-faint transition-colors duration-150 hover:text-ink"
						>
							<Archive size={12.5} strokeWidth={1.8} />
						</button>
					</span>
				</div>
			))}

			{group.sessions.length > COLLAPSED_SESSION_COUNT && (
				<button
					type="button"
					onClick={onToggleExpand}
					className={`flex w-full items-center pl-9 text-left text-[12.5px] text-ink-faint transition-colors hover:text-ink-muted ${
						compact ? "h-[32px]" : "h-[26px]"
					}`}
				>
					{expanded ? "收起" : `展开显示${hidden > 0 ? ` (${hidden})` : ""}`}
				</button>
			)}
		</div>
	);
}

function Arrow({ direction }: { direction: "left" | "right" }) {
	return (
		<svg
			width="15"
			height="15"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.9"
			strokeLinecap="round"
			strokeLinejoin="round"
			style={direction === "right" ? { transform: "scaleX(-1)" } : undefined}
		>
			<path d="M15 18l-6-6 6-6" />
		</svg>
	);
}

function groupSessions(
	sessions: SessionMeta[],
	projects: { path: string; name: string; pinned: boolean; lastOpenedAt: number }[],
	query: string,
): { pinned: Group[]; recent: Group[] } {
	const needle = query.trim().toLowerCase();
	const filtered = needle ? sessions.filter((s) => s.title.toLowerCase().includes(needle)) : sessions;

	const byPath = new Map<string, Group>();
	for (const project of projects) {
		byPath.set(project.path, { path: project.path, name: project.name, sessions: [] });
	}
	for (const session of filtered) {
		let group = byPath.get(session.cwd);
		if (!group) {
			group = { path: session.cwd, name: session.projectName, sessions: [] };
			byPath.set(session.cwd, group);
		}
		group.sessions.push(session);
	}

	const pinnedPaths = new Set(projects.filter((p) => p.pinned).map((p) => p.path));
	const order = new Map(projects.map((p, i) => [p.path, i]));
	const all = [...byPath.values()]
		// A project with no sessions is only worth a row when the user pinned it.
		.filter((g) => g.sessions.length > 0 || pinnedPaths.has(g.path))
		.sort((a, b) => (order.get(a.path) ?? 999) - (order.get(b.path) ?? 999));

	return {
		pinned: all.filter((g) => pinnedPaths.has(g.path)),
		recent: all.filter((g) => !pinnedPaths.has(g.path)),
	};
}

function activeProviderLabel(providers: { name: string; enabled: boolean; models: unknown[] }[]): string {
	const enabled = providers.filter((p) => p.enabled);
	if (enabled.length === 0) return "未配置模型供应商";
	const models = enabled.reduce((sum, p) => sum + p.models.length, 0);
	return `${enabled.map((p) => p.name).join(" · ")} · ${models} 个模型`;
}
