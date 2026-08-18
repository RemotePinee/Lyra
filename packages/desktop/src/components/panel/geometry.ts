/**
 * The side panel's nested geometry, which has exactly one solution.
 *
 * Two things have to be true at once. A tab's centre line must land at y=22, where the window's
 * own controls sit — the toolbar buttons beside it, or the traffic lights when the panel covers
 * the window. And the tab's corners must be concentric with the card's: nested rounded rectangles
 * look wrong unless the inner radius equals the outer radius minus the gap between them, and that
 * gap has to be the same above the tab as it is to its left, or the corner has no single correct
 * arc at all.
 *
 * Working back: 4px inset + 1px border + 4px gap + half of a 26px tab = 22. So the gap is 4 on
 * every side and the strip is 26 + 4 + 4 = 34 tall.
 *
 * The radius is measured from the card's *inner* edge, not its outer one. A 12px outer corner on a
 * 1px border leaves an 11px corner inside it, and the tab sits 4px in from there — so 7, not 8.
 * Change any one of these numbers and the rest have to move with it.
 */

export const PANEL_INSET = 4;
export const STRIP_HEIGHT = 34;
export const TAB_HEIGHT = 26;
export const CARD_RADIUS = 12;
const CARD_BORDER = 1;
export const TAB_RADIUS = CARD_RADIUS - CARD_BORDER - PANEL_INSET;

/**
 * Where the first window control sits, measured from the *window's* left edge.
 *
 * The three lights are 12pt wide on a 20pt pitch starting at x=16, so they end at 68.5; 78 leaves
 * the ~10pt gap the reference screenshots have, and 70 put the button flush against the green one.
 *
 * One number, shared with the toolbar, because the toolbar and the tab strip take turns drawing
 * this exact row — the panel hosts it once its left edge is the window's — and they were answering
 * the same question with 78 and 88. Ten pixels is small enough to look like a rendering wobble and
 * large enough to see, which is the worst size for a handover to be off by.
 */
export const WINDOW_CONTROLS_LEFT = 78;

/** How far the card's content starts inside the pane: the inset it draws, plus its border. */
const CARD_OFFSET = PANEL_INSET + CARD_BORDER;

/**
 * The same place, expressed as padding on the strip, which begins `CARD_OFFSET` in.
 *
 * Only the lights are reserved for. The toolbar buttons that follow them are rendered by the strip
 * itself, so they take their space in the flow.
 *
 * Dropped entirely in native full screen, where macOS takes the lights away — the inset would then
 * be holding a gap open around nothing.
 */
export const TRAFFIC_LIGHT_INSET = WINDOW_CONTROLS_LEFT - CARD_OFFSET;

/** macOS puts its window controls top-left; Windows and Linux put theirs on the right. */
export const MAC = navigator.userAgent.includes("Mac");

/** How far the fade reaches in from an edge that has more tabs past it. */
const FADE = 18;

/**
 * The strip's edge treatment: only the ends that actually hide something get one.
 *
 * `undefined` rather than a no-op gradient when nothing is clipped — a mask that fades to nothing
 * at 0% still costs a compositing layer, and more to the point it would dim the first tab's left
 * edge for no reason at all.
 */
export function maskFor({ start, end }: { start: boolean; end: boolean }): string | undefined {
	if (!start && !end) return undefined;
	const from = start ? `transparent 0, black ${FADE}px` : "black 0";
	const to = end ? `black calc(100% - ${FADE}px), transparent 100%` : "black 100%";
	return `linear-gradient(to right, ${from}, ${to})`;
}
