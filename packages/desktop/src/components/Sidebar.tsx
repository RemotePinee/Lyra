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
import { ProjectGroup } from "./sidebar/ProjectGroup.tsx";

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

	const groups = useMemo(
		() => groupSessions(listableSessions(sessions, activeSessionId), settings?.projects ?? [], query),
		[sessions, settings, query, activeSessionId],
	);

	const groupProps = (path: string) => ({
		expanded: expanded[path] === true,
		onToggleExpand: () => setExpanded((prev) => ({ ...prev, [path]: !prev[path] })),
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
				<span className="text-[16px] font-semibold tracking-tight text-ink">Lyra</span>
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
					className={`ly-scroll flex w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors duration-150 hover:bg-card-hover active:bg-elevated ${
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
