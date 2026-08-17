/**
 * The two things that sit either side of the conversation.
 *
 * Both change shape with the window — a pane at desktop widths, a drawer over the content when
 * there is no room beside it — and both are resizable at the widths where resizing means anything.
 * Kept apart from the layout state they read: this file draws, `layout.tsx` decides.
 */

import { useEffect, useRef, useState } from "react";
import { ResizeHandle } from "./components/ResizeHandle.tsx";
import { useFocusTrap, useLayout } from "./layout.tsx";

/**
 * The shell's navigation pane, in whichever form the window can afford.
 *
 * Wide enough, it is a column that pushes the content aside. Too narrow for that, it becomes a
 * drawer covering the window — the same pane, reached the same way, so nothing has to be
 * learned twice. Both the workspace sidebar and the settings nav render through here so the
 * two can never drift apart.
 */
export function NavPane({
	width,
	label,
	maxWidth,
	children,
}: {
	width: number;
	label: string;
	/**
	 * A ceiling lower than the pane's own, when the rest of the window needs the room.
	 *
	 * The workspace shell passes one computed from what is left after the conversation's floor and
	 * the panel's minimum. Absent — the settings window, which has neither beside it — the pane's
	 * own bound is the only limit there is.
	 */
	maxWidth?: number;
	children: React.ReactNode;
}) {
	const { compact, navOpen, setSidebarWidth, resetSidebarWidth, bounds } = useLayout();
	const ref = useRef<HTMLElement>(null);
	/**
	 * Suppresses the transition for one beat after the breakpoint moves.
	 *
	 * The two forms animate different properties — margin when pushing, transform when
	 * covering. Crossing the breakpoint swaps both the property and the value, and letting
	 * that interpolate produces a slide from nowhere to nowhere.
	 */
	const [snap, setSnap] = useState(false);

	useFocusTrap(ref, compact && navOpen);

	useEffect(() => {
		setSnap(true);
		const id = window.setTimeout(() => setSnap(false), 60);
		return () => window.clearTimeout(id);
	}, [compact]);

	const pane = (
		<aside
			ref={ref}
			aria-label={label}
			{...(compact ? { role: "dialog" as const, "aria-modal": true } : {})}
			// `inert`, not just aria-hidden: a closed pane is otherwise still in the tab order,
			// so Tab walks into something nobody can see.
			inert={!navOpen}
			/*
			 * Which form it is in, so the fill can differ.
			 *
			 * Beside the content it is translucent on purpose — that is the point of the
			 * vibrancy, and what shows through is the desktop. As a drawer it lies over the
			 * transcript, and 72% opacity means the conversation reads straight through the
			 * navigation: two columns of text on top of each other, neither legible.
			 */
			data-pane={compact ? "drawer" : "beside"}
			className={`${compact ? "fixed inset-0 z-30 shadow-2xl shadow-black/60" : "h-full w-full overflow-hidden"} ${
				snap ? "transition-none" : "transition-[opacity,transform] duration-[var(--ly-t-base)] ease-out"
			}`}
			style={compact ? { transform: navOpen ? "none" : "translateX(-100%)", opacity: navOpen ? 1 : 0 } : undefined}
		>
			{children}
		</aside>
	);

	if (compact) return pane;

	return (
		/*
		 * A frame around the pane, so the drag handle can hang outside it.
		 *
		 * The pane clips its own overflow — it has to, or a long title spills onto the content
		 * while the pane is sliding shut. That clipping is also what forced the resize handle to
		 * live *inside* the pane, on the same nine pixels of edge as the scrollbar's thumb, and no
		 * arrangement of layers fixes that: the thumb can only be reached when its scroller is
		 * hovered, and a pointer sitting on the handle is not hovering the scroller. Which meant
		 * the scrollbar was draggable or not depending on which direction you approached it from.
		 *
		 * The edge belongs to the boundary between two panes, not to either one of them. So the
		 * frame carries the width and the clipping stays on the pane, leaving the handle free to
		 * sit where the boundary actually is — one pixel inside, the rest over the content beside
		 * it. Nothing moved on screen: the scrollbar is where it was, the hairline is where it was.
		 * Only the invisible hit area stepped aside.
		 */
		<div
			className={`relative shrink-0 ${
				snap ? "transition-none" : "transition-[margin-left,opacity] duration-[var(--ly-t-base)] ease-out"
			}`}
			style={{ width, marginLeft: navOpen ? 0 : -width, opacity: navOpen ? 1 : 0 }}
		>
			{pane}

			{/*
			 * Only while it is a pane you can see beside the content. Closed, there is no edge —
			 * and a handle over the content with no pane attached to it resizes nothing.
			 */}
			{navOpen && (
				<ResizeHandle
					edge="end"
					// The width on screen, not the one in storage — a drag that started from the
					// remembered number would jump by the difference on its first move.
					width={width}
					min={bounds.sidebar.min}
					max={Math.min(bounds.sidebar.max, maxWidth ?? bounds.sidebar.max)}
					onResize={setSidebarWidth}
					onReset={resetSidebarWidth}
					label="调整侧边栏宽度"
				/>
			)}
		</div>
	);
}


/**
 * The panel side of the window, animated the same way the navigation is.
 *
 * It used to be mounted only while open, which produced three separate complaints and all of
 * them were the same fact: a subtree that appears fully formed cannot animate. The width was
 * final on the first frame, so the resize handle drew as a bare vertical line before there was
 * anything beside it; the entrance was a 24px nudge rather than the navigation's unfolding; and
 * the contents simply blinked into place. Keeping it mounted and moving it out past the edge
 * fixes all three, and has a fourth benefit — a terminal or a page in here survives the panel
 * being closed, which it never used to.
 */
export function SidePane({
	width,
	open,
	fullScreen,
	offset,
	handle,
	children,
}: {
	width: number;
	open: boolean;
	/** Covering the content column rather than sharing the row with it. */
	fullScreen: boolean;
	/** Where the covering form starts, so it stops short of the navigation. */
	offset: number;
	/**
	 * The drag handle, rendered outside the pane rather than in it.
	 *
	 * It used to be passed in with the children and therefore lived inside a box that clips its
	 * own overflow — which was survivable only while the handle sat wholly within the pane. It no
	 * longer does: it straddles the boundary now, to keep off the scrollbar's thumb, so the part
	 * hanging outside was simply cut away and what was left was a one-pixel strip. Same frame as
	 * `NavPane`, same reason.
	 */
	handle?: React.ReactNode;
	children: React.ReactNode;
}) {
	const { compact } = useLayout();
	const ref = useRef<HTMLElement>(null);
	/** Same reason as NavPane: the two forms animate different properties. */
	const [snap, setSnap] = useState(false);

	useFocusTrap(ref, compact && open);

	useEffect(() => {
		setSnap(true);
		const id = window.setTimeout(() => setSnap(false), 60);
		return () => window.clearTimeout(id);
	}, [compact, fullScreen]);

	const covering = compact || fullScreen;

	const pane = (
		<aside
			ref={ref}
			aria-label="面板"
			{...(compact ? { role: "dialog" as const, "aria-modal": true } : {})}
			// A closed pane is otherwise still in the tab order, so Tab walks into what nobody sees.
			inert={!open}
			data-pane={covering ? "cover" : "beside"}
			className={`${
				covering
					? `ly-opaque fixed inset-y-0 right-0 z-50 ${compact ? "left-0" : ""}`
					: "ly-opaque h-full w-full overflow-hidden"
			} ${snap ? "transition-none" : "transition-transform duration-[var(--ly-t-base)] ease-out"}`}
			/*
			 * Moved, never faded.
			 *
			 * The navigation can cross-fade because it is translucent by design — it is meant to
			 * have the desktop behind it. This one is opaque on purpose (a terminal or a web page
			 * must not have the transcript showing through it), and a half-transparent white panel over
			 * the window's vibrancy is grey. Fading it in meant every open began with a grey sheet
			 * that resolved to white, which read as a rendering glitch rather than as an entrance.
			 * Sliding alone is also simply the truer gesture: the panel arrives from the edge.
			 *
			 * Beside the content the sliding belongs to the frame below, which is what carries the
			 * width — two boxes both applying it would be twice as wide as either meant.
			 */
			style={covering ? { left: compact ? 0 : offset, transform: open ? "none" : "translateX(100%)" } : undefined}
		>
			{children}
		</aside>
	);

	/*
	 * Covering, there is no boundary to drag — the pane is over the content rather than beside it,
	 * and the frame would only add a box around something already positioned against the window.
	 */
	if (covering) return pane;

	return (
		<div
			className={`relative z-50 shrink-0 ${
				snap ? "transition-none" : "transition-[margin-right] duration-[var(--ly-t-base)] ease-out"
			}`}
			style={{ width, marginRight: open ? 0 : -width }}
		>
			{pane}
			{handle}
		</div>
	);
}
