/**
 * How the window divides itself between the conversation and the panel.
 *
 * Three panes, one window, and a floor the conversation is never pushed below. The rules read as
 * arithmetic but each one is a bug that was shipped once:
 *
 * The panel is squeezed rather than fixed — at 1110px with the sidebar out there is room for the
 * full 380, at 900 there is not, and a panel that refused to give any of it back left a column too
 * narrow to read a sentence in.
 *
 * The squeeze is applied at render rather than written back, so a window dragged narrow and out
 * again returns the panel to the width that was asked for instead of keeping whatever it was
 * squeezed to on the way through.
 *
 * And it re-runs while the window shrinks, not only when the panel opens. Open all three at a
 * comfortable width, then drag the window in, and nothing used to re-run: the column ended up
 * around 200px, where a sentence wraps every four characters.
 */

import { useEffect, useRef } from "react";
import { useLayout } from "./layout.tsx";
import { useSide } from "./sideStore.ts";

/** What the conversation keeps for itself before the panel is allowed any more. */
const CONTENT_MIN = 420;
/**
 * How much of the conversation stays uncovered once the panel starts overlapping it.
 *
 * Past `CONTENT_MIN` the panel stops taking the column's width and starts lying over it instead.
 * The sliver that remains is not there to be read — it is there so the conversation never becomes
 * a thing you have to remember is behind something. A panel that could close over it completely
 * would be indistinguishable from full screen, which is a separate mode reached deliberately.
 */
const CHAT_PEEK = 120;

export function usePanelLayout() {
	const {
		compact,
		width,
		navOpen,
		sidebarWidth,
		panelWidth: preferred,
		bounds,
		dismissNav,
		collapseNav,
	} = useLayout();
	const panelOpen = useSide((s) => s.panelOpen);
	const expanded = useSide((s) => s.expanded);

	/**
	 * Full-screen: the panel takes the conversation's whole column.
	 *
	 * Laid over it rather than squeezing it to nothing. A transcript reflowed to zero width and
	 * back costs a full re-layout of every message in it, and the scroll position does not survive
	 * the trip — covering it leaves the conversation exactly as it was underneath.
	 */
	const fullScreen = expanded && !compact;

	/**
	 * What the panel is entitled to keep while the sidebar is being sized against it.
	 *
	 * Its minimum, not its current width: the panel already yields down to that floor on its own,
	 * so holding back any more would stop the sidebar while there was still room to take.
	 */
	const panelReserve = panelOpen && !fullScreen && !compact ? bounds.panel.min : 0;

	/**
	 * The width the sidebar actually gets, which is not always the one it was given.
	 *
	 * `sidebarWidth` is a preference — what the user dragged it to, remembered across launches. The
	 * panel has always distinguished the two: its stored width is clamped against what is left, so
	 * a window too narrow for it simply shows less of it. The sidebar did not, and the difference
	 * showed the moment a window got small: it held its full 420 while the panel shrank to its own
	 * floor, and the column between them took whatever remained — at 900px that was a hundred
	 * pixels of conversation.
	 *
	 * Clamping here rather than writing the smaller number back keeps it a preference. Widen the
	 * window again and the sidebar returns to what it was, because nothing overwrote it.
	 */
	const sidebarActual =
		navOpen && !compact
			? Math.max(bounds.sidebar.min, Math.min(sidebarWidth, width - CONTENT_MIN - panelReserve))
			: 0;

	const available = width - sidebarActual;

	/**
	 * Two widths, because past a point the panel stops taking room and starts covering it.
	 *
	 * `panelWidth` is what you see. `panelLayoutWidth` is what the flex row is told, and it stops
	 * growing at the point where the conversation would drop below its floor. Beyond that the panel
	 * keeps widening leftwards over the column instead of pushing it.
	 *
	 * Splitting them is what makes the transition free of any jump. At the moment they part company
	 * the panel's left edge is exactly on the conversation's right edge, so the first covered pixel
	 * is the first pixel past the boundary — nothing moves, nothing reflows, and the column keeps
	 * the same layout width from there on. Squeezing it further instead would re-wrap every message
	 * in the transcript on every frame of the drag, and re-wrap them back on the way out.
	 */
	const squeezeCap = available - CONTENT_MIN;
	const overlayCap = available - CHAT_PEEK;
	const panelWidth = Math.max(bounds.panel.min, Math.min(preferred, bounds.panel.max, overlayCap));
	const panelLayoutWidth = Math.max(bounds.panel.min, Math.min(panelWidth, squeezeCap));

	/**
	 * Who draws the window's three buttons.
	 *
	 * The panel, whenever its left edge is the window's — compact, or full screen with the sidebar
	 * away. In every other layout something of the window is still up there and they stay in the
	 * toolbar. Exactly one of the two renders them, so they never double up.
	 */
	const panelHostsControls = panelOpen && (compact || (fullScreen && !navOpen));

	/**
	 * Opening the panel puts the sidebar away when all three cannot fit.
	 *
	 * Re-opening the sidebar afterwards is then a choice the user is allowed to make, rather than
	 * something that gets undone under them a frame later.
	 */
	const openPanel = (open: () => void) => {
		open();
		dismissNav();
		if (!compact && navOpen && width - sidebarActual - panelLayoutWidth < CONTENT_MIN) collapseNav();
	};

	/*
	 * Put away only once it cannot fit even at its narrowest.
	 *
	 * This used to test the sidebar's *preferred* width, so a window narrowing past a sidebar that
	 * happened to be wide made the whole pane vanish while there was still plenty of room for a
	 * narrow one. It now gives way by degrees — `sidebarActual` above shrinks it first — and
	 * disappearing is what happens at the end of that, not instead of it.
	 *
	 * Only while shrinking. Reacting to `navOpen` as well would mean re-opening the sidebar by
	 * hand gets undone a frame later, which is the app arguing with the user rather than
	 * responding to a window that genuinely no longer fits.
	 */
	const lastWidth = useRef(width);
	useEffect(() => {
		const shrinking = width < lastWidth.current;
		lastWidth.current = width;
		if (!shrinking || compact || !panelOpen || !navOpen) return;
		if (width < bounds.sidebar.min + CONTENT_MIN + bounds.panel.min) collapseNav();
	}, [width, compact, panelOpen, navOpen, collapseNav, bounds.sidebar.min, bounds.panel.min]);

	return {
		panelWidth,
		/** What the flex row reserves for it, which stops short once it starts overlapping. */
		panelLayoutWidth,
		/** Whether it is currently lying over the conversation rather than beside it. */
		panelOverlays: panelWidth > panelLayoutWidth,
		/** The clamped width to render the sidebar at — see `sidebarActual`. */
		sidebarWidth: sidebarActual,
		/**
		 * The most the resize handle may give it.
		 *
		 * The overlay cap, not the squeeze one: the handle has to be able to drag past the point
		 * where covering begins, or the mode would exist and be unreachable.
		 */
		panelMax: Math.max(bounds.panel.min, Math.min(bounds.panel.max, overlayCap)),
		/**
		 * The same floor, enforced from the other side.
		 *
		 * The panel has always yielded to the conversation — its width is clamped against
		 * `available - CONTENT_MIN` and its handle stops there. The sidebar never did: its ceiling
		 * was a flat 420 that asked nothing about how much room was left, so dragging it right kept
		 * going after the panel had already shrunk to its own minimum, and the column between them
		 * was whatever happened to remain. On a narrow window that is nothing.
		 *
		 * `panel.min` rather than the panel's current width, because the panel gives way first: by
		 * the time the sidebar is pushing, the panel is already down to its floor, and reserving
		 * more than that would stop the drag while there was still room to take.
		 *
		 * Never below `sidebar.min` — a ceiling under the floor would leave the handle unable to
		 * move in either direction on a window too small for all three.
		 */
		sidebarMax: Math.max(
			bounds.sidebar.min,
			Math.min(bounds.sidebar.max, width - CONTENT_MIN - (panelOpen && !fullScreen ? bounds.panel.min : 0)),
		),
		fullScreen,
		panelHostsControls,
		openPanel,
	};
}
