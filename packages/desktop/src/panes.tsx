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
	layoutWidth,
	open,
	fullScreen,
	offset,
	handle,
	children,
}: {
	width: number;
	/**
	 * What the row reserves for it, which is less than `width` once it starts covering.
	 *
	 * The two are equal while the panel sits beside the conversation. Past the point where the
	 * conversation would go below its floor this one stops growing and `width` keeps going, and the
	 * difference is exactly how far the panel reaches over the column. Doing it this way is what
	 * makes the crossover invisible: the reserved width is what the conversation is laid out
	 * against, so it stops changing at precisely the moment covering begins — no reflow on the
	 * frame the mode switches, and none on any frame after it.
	 */
	layoutWidth?: number;
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

	/*
	 * Only `compact` still snaps: that is the window changing shape, and the frame below appears or
	 * disappears in the same commit. Full screen is now just a width, and a width can be transitioned.
	 */
	useEffect(() => {
		setSnap(true);
		const id = window.setTimeout(() => setSnap(false), 60);
		return () => window.clearTimeout(id);
	}, [compact]);

	const covering = compact || fullScreen;

	const pane = (
		<aside
			ref={ref}
			aria-label="面板"
			{...(compact ? { role: "dialog" as const, "aria-modal": true } : {})}
			// A closed pane is otherwise still in the tab order, so Tab walks into what nobody sees.
			inert={!open}
			data-pane={covering ? "cover" : "beside"}
			/*
			 * One positioning model for both forms, so the change between them can be animated.
			 *
			 * Covering used to be `fixed` with a `left`, beside was `absolute` with a `width`. Nothing
			 * interpolates between those — different containing blocks, different properties — so the
			 * switch had to turn transitions off and snap. The shell already fills the window, so
			 * `absolute` against it describes the same rectangle `fixed` did; expressing the covering
			 * form as a width in `calc` leaves one property changing, and one property CSS can animate.
			 */
			className={`ly-opaque absolute inset-y-0 right-0 z-50 overflow-hidden ${
				snap ? "transition-none" : "transition-[width,transform] duration-[var(--ly-t-base)] ease-out"
			}`}
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
			 * reserved width. This one carries its *drawn* width and hangs off the frame's right
			 * edge, so the two differ by exactly how far it reaches over the conversation.
			 */
			style={
				covering
					? {
							// Right-anchored like the other form, so only the width differs between them.
							width: compact ? "100%" : `calc(100% - ${offset}px)`,
							transform: open ? "none" : "translateX(100%)",
						}
					: { width }
			}
		>
			{children}
		</aside>
	);

	const reserved = layoutWidth ?? width;
	/** How far the pane's left edge sits beyond the frame's, which is where the handle belongs. */
	const overhang = width - reserved;

	/*
	 * The frame is always rendered, even when it reserves nothing.
	 *
	 * It used to be skipped while covering — `if (covering) return pane` — which put the pane at a
	 * different depth in the tree depending on the form. React cannot reconcile those two as the same
	 * element, so switching to full screen unmounted the pane and mounted a new one: every transition
	 * on it was moot, because a transition belongs to an element and this was a different element.
	 * That is what made the expand button snap.
	 *
	 * `display: contents` makes the frame take part in nothing while covering — no box, no width, no
	 * effect on the row — while keeping the pane in one place in the tree. Same node throughout.
	 */
	return (
		<div
			className={
				covering
					? "contents"
					: `relative z-50 shrink-0 ${
							snap ? "transition-none" : "transition-[margin-right,width] duration-[var(--ly-t-base)] ease-out"
						}`
			}
			style={covering ? undefined : { width: reserved, marginRight: open ? 0 : -reserved }}
		>
			{pane}

			{/*
			 * A zero-width rail on the pane's left edge, for the handle to be positioned against.
			 *
			 * The handle knows how to straddle the edge of whatever contains it, and while the panel
			 * is beside the conversation that edge is the frame's. Once it overlaps, the two part
			 * company — the frame stops where the conversation's floor is, the pane carries on past
			 * it — and a handle still pinned to the frame would sit in the middle of the panel it is
			 * supposed to be the boundary of. Pinning it to a rail that tracks the overhang keeps it
			 * on the seam in both modes, with no second set of rules for the second mode.
			 */}
			{handle && (
				<div
					className={`absolute inset-y-0 w-0 ${
						snap ? "transition-none" : "transition-[left] duration-[var(--ly-t-base)] ease-out"
					}`}
					style={{ left: -overhang }}
				>
					{handle}
				</div>
			)}
		</div>
	);
}
