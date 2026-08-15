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

	const available = width - (navOpen && !compact ? sidebarWidth : 0);
	const panelWidth = Math.max(bounds.panel.min, Math.min(preferred, available - CONTENT_MIN));

	/**
	 * Full-screen: the panel takes the conversation's whole column.
	 *
	 * Laid over it rather than squeezing it to nothing. A transcript reflowed to zero width and
	 * back costs a full re-layout of every message in it, and the scroll position does not survive
	 * the trip — covering it leaves the conversation exactly as it was underneath.
	 */
	const fullScreen = expanded && !compact;

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
		if (!compact && navOpen && width - sidebarWidth - panelWidth < CONTENT_MIN) collapseNav();
	};

	/*
	 * Only while shrinking. Reacting to `navOpen` as well would mean re-opening the sidebar by
	 * hand gets undone a frame later, which is the app arguing with the user rather than
	 * responding to a window that genuinely no longer fits.
	 */
	const lastWidth = useRef(width);
	useEffect(() => {
		const shrinking = width < lastWidth.current;
		lastWidth.current = width;
		if (!shrinking || compact || !panelOpen || !navOpen) return;
		if (width < sidebarWidth + CONTENT_MIN + bounds.panel.min) collapseNav();
	}, [width, compact, panelOpen, navOpen, collapseNav, sidebarWidth, bounds.panel.min]);

	return {
		panelWidth,
		/** The most the resize handle may give it, with the conversation's floor honoured. */
		panelMax: Math.max(bounds.panel.min, Math.min(bounds.panel.max, available - CONTENT_MIN)),
		fullScreen,
		panelHostsControls,
		openPanel,
	};
}
