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
import { ChevronRight, Folder, SquarePen } from "lucide-react";
import { useLayout } from "../../layout.tsx";
import { ProjectMenu } from "../modals/ProjectMenu.tsx";
import { usePopover } from "../Popover.tsx";
import { ScrollText } from "../ScrollText.tsx";
import { Collapsible } from "./Collapsible.tsx";
import type { Group } from "./grouping.ts";
import { SessionRow } from "./SessionRow.tsx";
import { ShowMore } from "./ShowMore.tsx";

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
	collapsed,
	onToggleCollapsed,
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
	/** Folded shut, hiding its sessions. Remembered across launches. */
	collapsed: boolean;
	onToggleCollapsed: () => void;
	onShowMore: () => void;
	onCollapse: () => void;
	onOpenSession: (meta: SessionMeta) => void;
	onArchiveSession: (meta: SessionMeta) => void;
}) {
	const { compact } = useLayout();
	const menu = usePopover();
	const visible = group.sessions.slice(0, Math.max(COLLAPSED_SESSION_COUNT, shown));
	const hidden = group.sessions.length - visible.length;
	// Only worth offering once something has actually been opened up.
	const canCollapse = visible.length > COLLAPSED_SESSION_COUNT;

	return (
		<div className="mb-2 flex flex-col">
			{/* Same hover-owner arrangement as the session rows: the fill belongs to the row so
			    reaching for the menu button does not drop it. */}
			<div
				className="ly-scroll group/project relative rounded-lg transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover active:bg-elevated"
				onContextMenu={(event) => {
					event.preventDefault();
					// At the cursor: right-click acts on the row as a whole, so there is no one
					// control for the menu to hang off.
					menu.openAtPoint(event);
				}}
			>
				{/*
				 * The heading folds the project; switching to it moved into the menu.
				 *
				 * A project name is a heading for the rows under it, and the thing you want from a
				 * heading in a list this long is to be able to put it away. Switching workspace is
				 * the rarer intent and it already happens on its own whenever you open a session
				 * inside — so it lost the click and kept a menu item, rather than the two sharing
				 * one target and the fold never existing.
				 */}
				<button
					type="button"
					aria-expanded={!collapsed}
					onClick={onToggleCollapsed}
					className={`flex w-full items-center gap-2.5 rounded-lg pr-2 pl-2 text-left text-label transition-colors duration-[var(--ly-t-quick)] ${
						compact ? "h-[40px]" : "h-[31px]"
					} ${active ? "font-medium text-ink" : "text-ink group-hover/project:text-ink"}`}
				>
					{/*
					 * The folder turns into a chevron under the pointer.
					 *
					 * At rest the icon says what the row is; reaching for it, it says what pressing
					 * will do. Two marks in one place, neither of them a permanent extra control —
					 * and the rotation carries the open/shut state without a third element.
					 */}
					<span className={`relative h-[15px] w-[15px] shrink-0 ${active ? "text-accent" : "text-ink-muted"}`}>
						<Folder
							size={15}
							strokeWidth={1.8}
							className="absolute inset-0 transition-opacity duration-[var(--ly-t-quick)] group-hover/project:opacity-0"
						/>
						<ChevronRight
							size={15}
							strokeWidth={2}
							className={`absolute inset-0 opacity-0 transition-[opacity,transform] duration-[var(--ly-t-quick)] group-hover/project:opacity-100 ${
								collapsed ? "" : "rotate-90"
							}`}
						/>
					</span>
					<ScrollText text={group.name} className="ly-fade-tail min-w-0 flex-1" />
					{/*
					 * How many are folded away, so a shut project is not indistinguishable from an
					 * empty one. Only while shut: open, the rows themselves are the count.
					 *
					 * It vacates under the pointer, the same way the folder does. The menu button
					 * lives at this exact spot, and the two drawn together was not two things
					 * crowding each other — it was a numeral and an icon on the same pixels, legible
					 * as neither. Hovering is reaching for the button, so the count is what yields.
					 */}
					{collapsed && group.sessions.length > 0 && (
						<span className="shrink-0 text-caption text-ink-faint tabular-nums transition-opacity duration-[var(--ly-t-quick)] group-hover/project:opacity-0">
							{group.sessions.length}
						</span>
					)}
				</button>

				<span className="pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-r-lg pr-1.5 opacity-0 transition-opacity duration-[var(--ly-t-quick)] group-hover/project:opacity-100 focus-within:opacity-100">
					<button
						type="button"
						data-ly-tip="项目操作"
						aria-label={`「${group.name}」的项目操作`}
						aria-haspopup="menu"
						onClick={menu.toggle}
						className="pointer-events-auto rounded p-1 text-ink-faint transition-colors duration-[var(--ly-t-quick)] hover:text-ink"
					>
						<SquarePen size={12.5} strokeWidth={1.8} />
					</button>
				</span>
			</div>

			{menu.open && <ProjectMenu anchor={menu.anchor} path={group.path} name={group.name} onClose={menu.close} />}

			<Collapsible open={!collapsed}>
				{/* The gap lives here rather than on the outer column, or a folded project would keep
				    the space between rows it no longer has. */}
				<div className={`flex flex-col ${compact ? "gap-[5px] pt-[5px]" : "gap-[4px] pt-[4px]"}`}>
					{visible.map((session) => (
						<SessionRow
							key={session.id}
							session={session}
							active={activeSessionId === session.id}
							onOpen={() => onOpenSession(session)}
							onArchive={() => onArchiveSession(session)}
						/>
					))}

					<ShowMore hidden={hidden} canCollapse={canCollapse} onShowMore={onShowMore} onCollapse={onCollapse} />
				</div>
			</Collapsible>
		</div>
	);
}
