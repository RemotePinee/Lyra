/**
 * How deep the pinned rows reach, so the list can be softened below them rather than through them.
 *
 * The rows themselves are `position: sticky` and need nothing from JavaScript — the browser holds
 * them on the compositor, which is the only way they keep up with a wheel. This is the one thing
 * CSS cannot answer: where the *bottom* of the pinned band currently is, so the scroller's fade can
 * start there instead of at the top of the viewport.
 *
 * An earlier version placed the rows by hand, outside the scroller's mask, so they needed no fill
 * of their own and the translucent pane stayed translucent. It worked and it was wrong: the list
 * scrolls on the compositor and the placement ran on the main thread, so every pinned row sat one
 * wheel tick behind the list — measured at 14px of wobble on a trackpad. Pinned rows carry an
 * opaque fill now, and this number is all that is left.
 *
 * Being a frame late here costs nothing, which is the point of the split: the rows are placed by
 * CSS and cannot lag, and a fade whose start is a few pixels stale is a gradient in a slightly
 * different place — not a row that jumps.
 */

/** A pinned row, measured from the top of the scroll viewport. */
export interface StickyRow {
	top: number;
	bottom: number;
	/** The offset it comes to rest at — its own `top` in CSS terms. */
	rail: number;
}

/**
 * A hair over half a pixel.
 *
 * These are `getBoundingClientRect` values, so "has it reached its rail" is a comparison between
 * two subpixel numbers that agree in every way that matters until a fractional scroll position
 * makes them differ in the ninth decimal.
 */
const EPSILON = 0.5;

/**
 * Whether this row is currently being held rather than travelling with the list.
 *
 * A row counts once it has reached its rail — at or above it, which also covers the one being
 * pushed out by the next, since that travels upwards past its rail on the way out. A row still
 * arriving is not being held and covers nothing; it is part of the list, and the list is what the
 * fade is for.
 *
 * Asked twice, for two different reasons. The fade needs the depth below; the row itself needs to
 * know because being held is the only moment it may draw a fill — see `.ly-pin` and `data-ly-stuck`.
 * A row flowing with the list has nothing to hide and an opaque backing on it is just a band of the
 * wrong colour laid across a translucent pane.
 */
export function isPinned(row: StickyRow): boolean {
	return row.top <= row.rail + EPSILON;
}

/** The underside of the pinned band: the lowest edge of everything currently being held. */
export function pinnedDepth(rows: StickyRow[]): number {
	let depth = 0;
	for (const row of rows) {
		if (isPinned(row)) depth = Math.max(depth, row.bottom);
	}
	return depth;
}
