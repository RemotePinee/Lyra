/**
 * A project and the conversations under it.
 *
 * The rows are spaced rather than stacked flush. Their hover and selected states are filled
 * rounded rectangles, and with no gap two adjacent ones merge into a single block — you can no
 * longer tell where one session ends and the next begins.
 *
 * The open project is not filled, unlike the open session. Both used to take the same fill, so an
 * open project sitting directly above its own open session put two identical blocks four pixels
 * apart — one continuous grey slab with no hierarchy left in it. A project is a heading for the
 * sessions under it, not one of the things you pick between; it says it is open by the weight of
 * its name and the colour of its icon, and keeps the fill for hover, where it means "you are about
 * to press this".
 */

import type { SessionMeta } from "@lyra/core";
import { Folder, SquarePen } from "lucide-react";
import { useLayout } from "../../layout.tsx";
import { useApp } from "../../store.ts";
import { ProjectMenu } from "../modals/ProjectMenu.tsx";
import { usePopover } from "../Popover.tsx";
import { ScrollText } from "../ScrollText.tsx";
import type { Group } from "./grouping.ts";
import { SessionRow } from "./SessionRow.tsx";

/**
 * How many sessions a project shows before the rest are behind 展开显示, and how many more each
 * press reveals.
 *
 * The same number for both on purpose. One press used to open everything, which on a project with
 * forty conversations replaced a five-row group with a wall — and the only way back was a single
 * 收起 that threw away however far you had read. Revealing another five is a step you can take
 * repeatedly and stop at.
 */
const COLLAPSED_SESSION_COUNT = 5;
export const SESSION_PAGE = COLLAPSED_SESSION_COUNT;

export function ProjectGroup({
	group,
	active,
	activeSessionId,
	shown,
	onShowMore,
	onCollapse,
	onOpenSession,
	onArchiveSession,
}: {
	group: Group;
	active: boolean;
	activeSessionId: string | null;
	/** How many rows this group is currently showing. */
	shown: number;
	onShowMore: () => void;
	onCollapse: () => void;
	onOpenSession: (meta: SessionMeta) => void;
	onArchiveSession: (meta: SessionMeta) => void;
}) {
	const openWorkspace = useApp((s) => s.openWorkspace);
	const { compact, dismissNav } = useLayout();
	const menu = usePopover();
	const visible = group.sessions.slice(0, Math.max(COLLAPSED_SESSION_COUNT, shown));
	const hidden = group.sessions.length - visible.length;
	// Only worth offering once something has actually been opened up.
	const canCollapse = visible.length > COLLAPSED_SESSION_COUNT;

	return (
		<div className={`mb-2 flex flex-col ${compact ? "gap-[5px]" : "gap-[4px]"}`}>
			{/* Same hover-owner arrangement as the session rows: the fill belongs to the row so
			    reaching for the menu button does not drop it. */}
			<div
				className="ly-scroll group/project relative rounded-lg transition-colors duration-150 hover:bg-card-hover active:bg-elevated"
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
					className={`flex w-full items-center gap-2.5 rounded-lg pr-2 pl-2 text-left text-label transition-colors duration-150 ${
						compact ? "h-[40px]" : "h-[31px]"
					} ${active ? "font-medium text-ink" : "text-ink group-hover/project:text-ink"}`}
				>
					<Folder size={15} strokeWidth={1.8} className={`shrink-0 ${active ? "text-accent" : "text-ink-muted"}`} />
					<ScrollText text={group.name} className="ly-fade-tail min-w-0 flex-1" />
				</button>

				<span className="pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-r-lg pr-1.5 opacity-0 transition-opacity duration-150 group-hover/project:opacity-100 focus-within:opacity-100">
					<button
						type="button"
						data-ly-tip="项目操作"
						aria-label={`「${group.name}」的项目操作`}
						aria-haspopup="menu"
						onClick={menu.toggle}
						className="pointer-events-auto rounded p-1 text-ink-faint transition-colors duration-150 hover:text-ink"
					>
						<SquarePen size={12.5} strokeWidth={1.8} />
					</button>
				</span>
			</div>

			{menu.open && <ProjectMenu anchor={menu.anchor} path={group.path} name={group.name} onClose={menu.close} />}

			{visible.map((session) => (
				<SessionRow
					key={session.id}
					session={session}
					active={activeSessionId === session.id}
					onOpen={() => onOpenSession(session)}
					onArchive={() => onArchiveSession(session)}
				/>
			))}

			{/*
			 * Two separate actions rather than one toggle.
			 *
			 * "More" and "back to the top" are different intentions, and a single control that means
			 * whichever one the current state implies makes the second press unpredictable. The count
			 * is what is left, not what a press will reveal — how much more there is is the question
			 * being asked.
			 */}
			{(hidden > 0 || canCollapse) && (
				<div className={`flex items-center gap-3 pl-9 ${compact ? "h-[32px]" : "h-[26px]"}`}>
					{hidden > 0 && (
						<button
							type="button"
							onClick={onShowMore}
							className="text-left text-label text-ink-faint transition-colors hover:text-ink-muted"
						>
							展开显示 ({hidden})
						</button>
					)}
					{canCollapse && (
						<button
							type="button"
							onClick={onCollapse}
							className="text-left text-label text-ink-faint transition-colors hover:text-ink-muted"
						>
							收起
						</button>
					)}
				</div>
			)}
		</div>
	);
}
