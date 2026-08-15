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

/** Past this many, the rest are behind "展开显示". */
const COLLAPSED_SESSION_COUNT = 5;

export function ProjectGroup({
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
					className={`flex w-full items-center gap-2.5 rounded-lg pr-2 pl-2 text-left text-[13px] transition-colors duration-150 ${
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
