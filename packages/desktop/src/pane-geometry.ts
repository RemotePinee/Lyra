/**
 * How wide the panel is drawn, and how much the row gives up for it.
 *
 * Two numbers, kept apart from the component that applies them, because the bug they encode is
 * invisible everywhere else: it type-checks, it renders, and a screenshot of either end state looks
 * correct. It is only wrong in the frames between — and only if you are watching the conversation
 * rather than the panel.
 */

export interface PaneGeometry {
	/** The panel is open rather than parked off the right edge. */
	open: boolean;
	/** The window is too narrow to hold three columns, so the panel is a drawer over everything. */
	compact: boolean;
	/** The panel is covering the conversation's column rather than sharing the row with it. */
	fullScreen: boolean;
	/** What the row reserved for it before it began covering — see `panelLayoutWidth`. */
	reserved: number;
	/** Its drawn width while it sits beside the conversation. */
	width: number;
	/** Where the covering form starts, so it stops short of the navigation. */
	offset: number;
}

/**
 * What the flex row holds open for the panel.
 *
 * **Full screen is not in this answer, and that is the whole point.** Full screen means the panel is
 * laid *over* the conversation; the reason it covers rather than collapses the column is that a
 * transcript reflowed to nothing and back loses its wrapping and its scroll position. Releasing the
 * reserved width on the way in released exactly that — the column re-laid itself out at full width
 * in one frame while the panel was still short of covering it, so entering showed a strip of
 * freshly re-wrapped conversation and leaving showed the same strip snap back.
 *
 * Compact is different and does belong here: there the panel is a drawer over the whole window, and
 * the conversation underneath really is full width.
 */
export function rowReserve({ open, compact, reserved }: Pick<PaneGeometry, "open" | "compact" | "reserved">): number {
	return open && !compact ? reserved : 0;
}

/**
 * The width the pane is drawn at, as a CSS length.
 *
 * A percentage while covering and a pixel count while beside, both resolved against the shell — one
 * property, one containing block, so the change between the two forms is something CSS can
 * interpolate. Expressing covering as `left` against a different containing block is what used to
 * force the transition off and make the switch snap.
 */
export function paneWidth({
	compact,
	fullScreen,
	width,
	offset,
}: Pick<PaneGeometry, "compact" | "fullScreen" | "width" | "offset">): string {
	if (compact) return "100%";
	if (fullScreen) return `calc(100% - ${offset}px)`;
	return `${width}px`;
}
