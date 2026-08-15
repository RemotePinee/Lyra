/**
 * A row that opens into its own detail, as one object.
 *
 * The panels used to draw this as two things: a highlighted row, then a separate bordered box
 * floating under it at an indent that lined up with nothing. Two shapes, a seam between them, and
 * an inset borrowed from a different component's geometry — which is why it read as stuck on rather
 * than opened.
 *
 * Here the row and its detail live inside one border, and the body is separated by a rule rather
 * than by a gap. It is the same shape the transcript's tool cards use, so a panel looks like the
 * conversation beside it rather than like a different application.
 *
 * When it is open the row pins to the top of the panel while its own body scrolls past, so a long
 * detail never leaves you reading output with no idea which step produced it. That is also why the
 * card cannot clip its contents: `overflow: hidden` on an ancestor makes it the scroll container
 * for anything sticky inside, which would pin the row to the card — a box that is exactly as tall
 * as the row, so nothing would appear to happen at all. The corners are rounded on the row instead.
 *
 * Two details the eye catches immediately when they are wrong. The row sits *inside* the card's
 * 1px border, so its radius has to be the card's minus that border — a matching 10px squares the
 * corners visibly and lets the border show through them. And a pinned row has to be opaque, so it
 * takes the card's own colour rather than a floating-surface one: anything else and the row changes
 * shade the moment it sticks.
 */

import { ChevronRight } from "lucide-react";

export function DetailCard({
	open,
	onToggle,
	label,
	summary,
	trailing,
	children,
}: {
	open: boolean;
	onToggle: () => void;
	/** A short kind, shown before the summary. Optional: some rows are self-describing. */
	label?: string;
	summary: React.ReactNode;
	/** Duration, sequence number, status dot — whatever belongs at the end of the row. */
	trailing?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<div
			className={`dw-enter mb-1 rounded-[10px] border transition-colors duration-200 ${
				open ? "border-line-soft bg-card" : "border-transparent"
			}`}
		>
			<button
				type="button"
				onClick={onToggle}
				className={`dw-scroll flex w-full items-center gap-2 rounded-[9px] px-2 py-[6px] text-left transition-colors duration-150 hover:bg-card-hover/50 ${
					open ? "sticky top-0 z-10 rounded-b-none bg-card" : ""
				}`}
			>
				{label && <span className="shrink-0 text-[10.5px] text-ink-faint">{label}</span>}
				<span className="min-w-0 flex-1 truncate text-[12px] text-ink-muted">{summary}</span>
				{trailing}
				<ChevronRight
					size={12}
					strokeWidth={2}
					className="shrink-0 text-ink-faint transition-transform duration-200"
					style={open ? { transform: "rotate(90deg)" } : undefined}
				/>
			</button>

			{open && <div className="border-t border-line-soft">{children}</div>}
		</div>
	);
}
