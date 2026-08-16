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
import { Archive } from "lucide-react";
import { useLayout } from "../../layout.tsx";
import { useApp } from "../../store.ts";
import { ScrollText } from "../ScrollText.tsx";
import { SessionStatus } from "../SessionStatus.tsx";

export function SessionRow({
	session,
	active,
	onOpen,
	onArchive,
}: {
	session: SessionMeta;
	active: boolean;
	onOpen: () => void;
	onArchive: () => void;
}) {
	// Subscribed here rather than threaded through: it changes for reasons this row's other props
	// know nothing about — a turn ending in a conversation nobody has open.
	const activity = useApp((s) => s.activity);
	const { compact } = useLayout();

	return (
		<div
			className={`ly-scroll group/session relative rounded-lg transition-colors duration-[var(--ly-t-quick)] active:bg-elevated ${
				active ? "bg-card-hover" : "hover:bg-card-hover"
			}`}
		>
			<button
				type="button"
				onClick={onOpen}
				className={`flex w-full items-center gap-2 rounded-lg pr-7 pl-3.5 text-left text-label transition-colors duration-[var(--ly-t-quick)] ${
					compact ? "h-[34px]" : "h-[27px]"
				} ${active ? "text-ink" : "text-ink-muted group-hover/session:text-ink"}`}
			>
				{/* In the indent the titles already had, so nothing moved to make room for it. */}
				<SessionStatus activity={visibleActivity(activity[session.id] ?? null, active)} />
				<ScrollText text={session.title} className="ly-fade-tail min-w-0 flex-1" />
			</button>

			{/* The strip never takes pointer events; only the button does. Anything wider would
			    shadow the row button and cost it its hover. */}
			<span className="pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-r-lg pr-1.5 opacity-0 transition-opacity duration-[var(--ly-t-quick)] group-hover/session:opacity-100 focus-within:opacity-100">
				<button
					type="button"
					data-ly-tip="归档会话"
					aria-label={`归档会话「${session.title}」`}
					onClick={onArchive}
					className="pointer-events-auto rounded p-1 text-ink-faint transition-colors duration-[var(--ly-t-quick)] hover:text-ink"
				>
					<Archive size={12.5} strokeWidth={1.8} />
				</button>
			</span>
		</div>
	);
}
