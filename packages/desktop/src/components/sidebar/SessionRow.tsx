/**
 * One conversation in the sidebar.
 *
 * The row, not the button inside it, owns the hover state. The archive affordance is a sibling
 * laid over the button's right-hand end, so a pointer sitting there is outside the button —
 * hanging `hover:` on the button meant the fill and the text colour dropped out the moment you
 * reached for the icon, while the icon itself (keyed off the row) stayed.
 *
 * The title stops short of the archive button, always. It used to run the full width with the
 * icon on top of it, so a long name and the icon overlapped into something neither could be read
 * through. A gradient behind the icon was the previous answer, but the sidebar is translucent —
 * there is no colour to fade to that reliably covers text. Reserving the space costs a few
 * characters and cannot go wrong; the full title is a hover away in the scroller either way.
 */

import type { SessionMeta } from "@lyra/core";
import { visibleActivity } from "@lyra/core/activity";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { useState } from "react";
import { useLayout } from "../../layout.tsx";
import { sessionTitle } from "../../sessionTitle.ts";
import { useApp } from "../../store.ts";
import { SessionCard, useSessionCard } from "./SessionCard.tsx";
import { ScrollText } from "../ScrollText.tsx";
import { SessionStatus } from "../SessionStatus.tsx";
import { useTypedText } from "../TypedText.tsx";

/**
 * How recently a conversation must have been created for its row to drop in.
 *
 * The row appears the instant the first message is sent, so in the case this is for the gap is
 * a few milliseconds. The allowance is for the other way a row can be new — a turn started on
 * the phone, arriving with the next session list — and it has to stay short, or scrolling a
 * long sidebar would replay the entrance for whatever happens to have been made a minute ago.
 */
const JUST_CREATED_MS = 1500;

/**
 * What a row can do, as one thing rather than four callbacks threaded through every list.
 *
 * Which of them exist is what tells a row where it is: a conversation in the sidebar can be
 * archived, one in the archive can be restored or deleted, and neither list needs to be told which
 * one it is beyond being handed the right set.
 */
export interface RowActions {
	onOpen: (session: SessionMeta) => void;
	onArchive?: (session: SessionMeta) => void;
	onRestore?: (session: SessionMeta) => void;
	onDelete?: (session: SessionMeta) => void;
}

/** Bind a set of actions to one conversation, for spreading onto its row. */
export function rowActions(actions: RowActions, session: SessionMeta) {
	const bind = (act: ((session: SessionMeta) => void) | undefined) => (act ? () => act(session) : undefined);
	return {
		onOpen: () => actions.onOpen(session),
		onArchive: bind(actions.onArchive),
		onRestore: bind(actions.onRestore),
		onDelete: bind(actions.onDelete),
	};
}

export function SessionRow({
	session,
	active,
	project,
	onRestore,
	onDelete,
	onOpen,
	onArchive,
}: {
	session: SessionMeta;
	active: boolean;
	/**
	 * What this conversation belongs to, shown on hover rather than on the row.
	 *
	 * Under a project the folder row above already answers this, so it is only passed by 「聊天」,
	 * where there is no folder row. It used to be printed inline; a second column of names in a
	 * list of forty competes with the titles for a pane that is 240px wide, and the titles are the
	 * thing being read. In the tip it costs nothing and is there when it is wanted.
	 */
	project?: string;
	onOpen: () => void;
	/** Absent in the archive, where a row is already filed away. */
	onArchive?: () => void;
	/** Both present only in the archive: put it back, or end it. */
	onRestore?: () => void;
	onDelete?: () => void;
}) {
	// Subscribed here rather than threaded through: it changes for reasons this row's other props
	// know nothing about — a turn ending in a conversation nobody has open.
	const activity = useApp((s) => s.activity);
	const { compact } = useLayout();

	/*
	 * Two motions, for the two things that happen to a new conversation's name.
	 *
	 * It arrives as 「新对话」 — the row drops in from above, because a row appearing out of
	 * nowhere in a list you are looking at is the sort of change the eye reports as "something
	 * moved" without being able to say what. Then, a moment later, the runtime derives the real
	 * title from the first message, and that one is a rewrite rather than an arrival: the row is
	 * already yours and only its name is being corrected.
	 *
	 * Decided once, at mount. Re-reading the clock on every render would let a row stop being new
	 * mid-animation, and `useState`'s initialiser is the one place that runs exactly once.
	 */
	const [justCreated] = useState(() => Date.now() - session.createdAt < JUST_CREATED_MS);
	const title = useTypedText(sessionTitle(session.title));
	/*
	 * Everything the row cannot fit, on a pause rather than on every render.
	 *
	 * The row shows a title; the card shows the full one plus where it lives and what it has cost.
	 * Both lists use it — under a project the folder above already names the project, so only 「聊天」
	 * passes one, but the path and the figures are worth having in either.
	 */
	const card = useSessionCard();

	return (
		<div
			{...card.bind}
			/*
			 * How deep the title has to dissolve on hover: as wide as this row's own controls.
			 *
			 * The archive has three, everywhere else has one — a fixed depth would either leave the
			 * archive's buttons sitting on legible text or dissolve far more than the one button
			 * elsewhere ever covers.
			 */
			style={{ "--ly-row-controls": onRestore && onDelete ? "58px" : "34px" } as React.CSSProperties}
			className={`ly-scroll group/session relative rounded-lg transition-colors duration-[var(--ly-t-quick)] active:bg-elevated ${
				justCreated ? "ly-drop" : ""
			} ${active ? "bg-card-hover" : "hover:bg-card-hover"}`}
		>
			{card.anchor && <SessionCard session={session} anchor={card.anchor} project={project} leaving={card.leaving} />}
			<button
				type="button"
				onClick={onOpen}
				/*
				 * The room for the controls appears with the controls, and not before.
				 *
				 * Reserved permanently — `pr-12` in the archive, `pr-7` elsewhere — every row in a
				 * list of forty was short by that much all of the time, for buttons that are only
				 * there while you are pointing at one; in a pane dragged wide it read as a column of
				 * dead space down the right-hand side.
				 *
				 * Reserving *on hover* is what both halves need. The padding is what actually keeps
				 * the title out from under the icons: the pane is translucent, so there is no colour
				 * a gradient behind an icon could fade to, and `ly-fade-tail` softens the title's end
				 * rather than hiding it — text under a button stays half-legible, and the two read as
				 * overlapping. The mask still runs, over the width being given up, which is what
				 * keeps the last word from being sliced mid-letter while the padding eases in.
				 */
				className={`flex w-full items-center gap-2 rounded-lg pl-2 text-left text-label transition-[padding,color,background-color] duration-[var(--ly-t-quick)] ${
					onRestore && onDelete
						? "pr-2 group-hover/session:pr-12 group-focus-within/session:pr-12"
						: "pr-2 group-hover/session:pr-7 group-focus-within/session:pr-7"
				} ${compact ? "h-[34px]" : "h-[27px]"} ${
					active ? "text-ink" : "text-ink-muted group-hover/session:text-ink"
				}`}
			>
				{/* In the indent the titles already had, so nothing moved to make room for it. */}
				<SessionStatus activity={visibleActivity(activity[session.id] ?? null, active)} />
				<ScrollText text={title} className="ly-fade-tail min-w-0 flex-1" />
			</button>

			{/* The strip never takes pointer events; only the button does. Anything wider would
			    shadow the row button and cost it its hover. */}
			<span className="pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-r-lg pr-1.5 opacity-0 transition-opacity duration-[var(--ly-t-quick)] group-hover/session:opacity-100 focus-within:opacity-100">
				{/*
				 * The settled name in every label, not the one being typed: a title read aloud
				 * mid-rewrite is a truncation of a name nobody ever gave this conversation.
				 */}
				{onRestore && (
					<button
						type="button"
						data-ly-tip="取消归档"
						aria-label={`取消归档「${sessionTitle(session.title)}」`}
						onClick={onRestore}
						className="pointer-events-auto rounded p-1 text-ink-faint transition-colors duration-[var(--ly-t-quick)] hover:text-ink"
					>
						<ArchiveRestore size={12.5} strokeWidth={1.8} />
					</button>
				)}
				{/*
				 * Red on hover only. An archive is a list of things you have already put away, so a
				 * permanently red control on every row of it reads as a warning about the list
				 * rather than as one button on one row.
				 */}
				{onDelete && (
					<button
						type="button"
						data-ly-tip="删除"
						aria-label={`删除「${sessionTitle(session.title)}」`}
						onClick={onDelete}
						className="pointer-events-auto rounded p-1 text-ink-faint transition-colors duration-[var(--ly-t-quick)] hover:text-danger"
					>
						<Trash2 size={12.5} strokeWidth={1.8} />
					</button>
				)}
				{onArchive && (
					<button
						type="button"
						data-ly-tip="归档会话"
						aria-label={`归档会话「${sessionTitle(session.title)}」`}
						onClick={onArchive}
						className="pointer-events-auto rounded p-1 text-ink-faint transition-colors duration-[var(--ly-t-quick)] hover:text-ink"
					>
						<Archive size={12.5} strokeWidth={1.8} />
					</button>
				)}
			</span>
		</div>
	);
}
