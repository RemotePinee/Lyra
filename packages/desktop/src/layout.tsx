/**
 * Window-size driven layout modes.
 *
 * The window can be dragged from full screen down to 380pt, and the shell has to change shape
 * along the way rather than just squeezing. Three modes:
 *
 *   wide     ≥1180  sidebar pushes the content; the side panel sits beside the transcript
 *   regular  ≥760   sidebar pushes the content; the side panel sits beside it too, narrower
 *   compact  <760   sidebar becomes a full-window drawer; the side panel takes the window
 *
 * The side panel never overlays a dimmed transcript. Its entire reason to exist is watching
 * one thing while working in the other, and a scrim says the opposite — that what is behind it
 * has been set aside. Above `compact` it always takes width from the content rather than
 * covering it, and gets narrow enough that there is content left to take it from.
 *
 * The mode lives in one place so behaviour (drawer vs push) and styling (paddings, card
 * columns) can never disagree — a phone-shaped window wearing desktop paddings was the
 * failure this replaces. `data-layout` is mirrored onto <html> for the few rules that are
 * easier to express in CSS than in props.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, storedWidth } from "./layout-widths.ts";

/** Below this the sidebar and a readable content column no longer fit side by side. */
const COMPACT_MAX = 760;
/** Above this the review panel can sit beside the transcript without starving either. */
const WIDE_MIN = 1180;

export type LayoutMode = "compact" | "regular" | "wide";

function modeFor(width: number): LayoutMode {
	if (width < COMPACT_MAX) return "compact";
	if (width < WIDE_MIN) return "regular";
	return "wide";
}

export interface LayoutValue {
	mode: LayoutMode;
	compact: boolean;
	/** True when there is room for a full-width side panel rather than a squeezed one. */
	wide: boolean;
	/** Current window width, for callers that budget space rather than just pick a mode. */
	width: number;
	/** Whether the navigation pane is showing, in whichever form this mode uses. */
	navOpen: boolean;
	/**
	 * Pane widths, as the user last dragged them.
	 *
	 * These are the *preferred* widths and are clamped only to their own sensible bounds. What
	 * actually fits also depends on the window and on what else is open, so the layout narrows
	 * them further at render time without overwriting the preference — drag the window in and
	 * back out, and the panes return to the widths that were asked for.
	 */
	sidebarWidth: number;
	panelWidth: number;
	setSidebarWidth: (next: number) => void;
	setPanelWidth: (next: number) => void;
	resetSidebarWidth: () => void;
	resetPanelWidth: () => void;
	/** The bounds the handles enforce, so callers do not restate them. */
	bounds: { sidebar: { min: number; max: number }; panel: { min: number; max: number } };
	/**
	 * The window is in macOS native full screen, so the traffic lights are not drawn.
	 *
	 * Everything that insets itself to clear them has to stop doing so, or the space they would
	 * have occupied stays open around nothing.
	 */
	nativeFullScreen: boolean;
	toggleNav: () => void;
	/**
	 * Close the drawer after an action that navigates somewhere. A no-op outside compact,
	 * because a pushed sidebar should stay put when you pick a session from it.
	 */
	dismissNav: () => void;
	/**
	 * Put the sidebar away in whichever form it is currently in.
	 *
	 * Unlike `dismissNav` this also collapses a pushed sidebar — used when opening the side
	 * panel would otherwise leave the conversation too narrow to read. Navigation is the thing
	 * you need least while working in two panes at once.
	 */
	collapseNav: () => void;
}

/**
 * Pane widths the user has set by dragging, and the bounds they are kept inside.
 *
 * Persisted in `localStorage` rather than in Settings: this is a per-window preference with no
 * meaning on the phone, and reading it synchronously on the first render is what stops the panes
 * jumping from their defaults to the saved widths a frame later.
 */

const LayoutContext = createContext<LayoutValue | null>(null);

export function LayoutProvider({ children }: { children: React.ReactNode }) {
	const [width, setWidth] = useState(() => window.innerWidth);
	const mode = modeFor(width);
	// The two forms keep separate state: entering compact must not throw a full-window drawer
	// in the user's face, and leaving it must not hide a sidebar they had open.
	const [pushOpen, setPushOpen] = useState(true);
	const [drawerOpen, setDrawerOpen] = useState(false);

	const [sidebarWidth, setSidebarWidthState] = useState(() =>
		storedWidth("dw:sidebar-width", SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX),
	);
	const [panelWidth, setPanelWidthState] = useState(() =>
		storedWidth("dw:panel-width", PANEL_DEFAULT, PANEL_MIN, PANEL_MAX),
	);

	/*
	 * Written on every frame of the drag, deliberately.
	 *
	 * `localStorage` is synchronous, and one small string per frame is nothing next to the
	 * relayout the same frame is already doing. Debouncing it would mean a width lost whenever
	 * the app is closed within the debounce window — the one moment it matters most.
	 */
	const setSidebarWidth = useCallback((next: number) => {
		const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, next));
		setSidebarWidthState(clamped);
		window.localStorage.setItem("dw:sidebar-width", String(Math.round(clamped)));
	}, []);

	const setPanelWidth = useCallback((next: number) => {
		const clamped = Math.min(PANEL_MAX, Math.max(PANEL_MIN, next));
		setPanelWidthState(clamped);
		window.localStorage.setItem("dw:panel-width", String(Math.round(clamped)));
	}, []);

	const resetSidebarWidth = useCallback(() => setSidebarWidth(SIDEBAR_DEFAULT), [setSidebarWidth]);
	const resetPanelWidth = useCallback(() => setPanelWidth(PANEL_DEFAULT), [setPanelWidth]);

	/*
	 * Freeze transitions for the duration of a drag.
	 *
	 * Every pane here animates its width or margin over ~200ms. That is right for a click, and
	 * wrong while an edge is being dragged: each frame restarts an animation the next frame
	 * overrides, so the panes trail the window instead of tracking it, and the composited
	 * layers (the blur behind menus, the mask on the tab strip) smear over what has already
	 * been repainted. Marking the drag lets CSS drop the animation and land on the final
	 * geometry immediately; the flag clears shortly after the last resize event.
	 */
	useEffect(() => {
		let idle: number | undefined;
		const onResize = () => {
			setWidth(window.innerWidth);
			document.documentElement.dataset.resizing = "";
			window.clearTimeout(idle);
			idle = window.setTimeout(() => delete document.documentElement.dataset.resizing, 140);
		};
		window.addEventListener("resize", onResize);
		return () => {
			window.removeEventListener("resize", onResize);
			window.clearTimeout(idle);
			delete document.documentElement.dataset.resizing;
		};
	}, []);

	useEffect(() => {
		document.documentElement.dataset.layout = mode;
	}, [mode]);

	const compact = mode === "compact";

	/*
	 * Reported by the window, because the page has no way to see it.
	 *
	 * The lights are drawn by macOS outside the document, and `titlebar-area-*` is the Windows
	 * overlay API rather than a general one. Defaults to false, which is right for every other
	 * platform and for the ordinary windowed case.
	 */
	const [nativeFullScreen, setNativeFullScreen] = useState(false);
	useEffect(() => window.deepwise?.onFullScreenChange?.(setNativeFullScreen), []);

	// Crossing the breakpoint in either direction dismisses the drawer; it is a transient
	// overlay, and carrying it across a reflow leaves it stranded over the wrong layout.
	useEffect(() => {
		setDrawerOpen(false);
	}, [compact]);

	const toggleNav = useCallback(() => {
		if (compact) setDrawerOpen((open) => !open);
		else setPushOpen((open) => !open);
	}, [compact]);

	const dismissNav = useCallback(() => {
		if (compact) setDrawerOpen(false);
	}, [compact]);

	const collapseNav = useCallback(() => {
		if (compact) setDrawerOpen(false);
		else setPushOpen(false);
	}, [compact]);

	const value = useMemo<LayoutValue>(
		() => ({
			mode,
			compact,
			wide: mode === "wide",
			width,
			navOpen: compact ? drawerOpen : pushOpen,
			nativeFullScreen,
			sidebarWidth,
			panelWidth,
			setSidebarWidth,
			setPanelWidth,
			resetSidebarWidth,
			resetPanelWidth,
			bounds: {
				sidebar: { min: SIDEBAR_MIN, max: SIDEBAR_MAX },
				panel: { min: PANEL_MIN, max: PANEL_MAX },
			},
			toggleNav,
			dismissNav,
			collapseNav,
		}),
		[
			mode,
			compact,
			width,
			drawerOpen,
			pushOpen,
			nativeFullScreen,
			sidebarWidth,
			panelWidth,
			setSidebarWidth,
			setPanelWidth,
			resetSidebarWidth,
			resetPanelWidth,
			toggleNav,
			dismissNav,
			collapseNav,
		],
	);

	return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

export function useLayout(): LayoutValue {
	const value = useContext(LayoutContext);
	if (!value) throw new Error("useLayout must be used inside <LayoutProvider>");
	return value;
}

/**
 * Hold keyboard focus inside a full-window drawer and hand it back when the drawer goes.
 *
 * Without this, Tab walks straight out of a drawer that visually covers everything and lands
 * on the transcript behind it — the caret disappears and the next Enter hits the wrong thing.
 */
/** What counts as focusable, for the trap below. */
const FOCUSABLE =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, active: boolean): void {
	useEffect(() => {
		const container = ref.current;
		if (!active || !container) return;

		const restoreTo = document.activeElement as HTMLElement | null;
		const focusable = () =>
			[...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);

		focusable()[0]?.focus();

		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Tab") return;
			const list = focusable();
			if (list.length === 0) return;
			const first = list[0];
			const last = list[list.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};

		container.addEventListener("keydown", onKey);
		return () => {
			container.removeEventListener("keydown", onKey);
			// Only reclaim focus if it is still ours to give back; the user may have clicked
			// elsewhere, and stealing it back from them would be worse than losing it.
			const current = document.activeElement;
			if (current === document.body || container.contains(current)) restoreTo?.focus();
		};
	}, [ref, active]);
}

export { NavPane, SidePane } from "./panes.tsx";
