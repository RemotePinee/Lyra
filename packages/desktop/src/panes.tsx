/**
 * The navigation pane, which is the one thing in the window that is not in the dock.
 *
 * It changes shape with the window — a column at desktop widths, a drawer over the content when
 * there is no room beside it — and is resizable at the widths where resizing means anything. Kept
 * apart from the layout state it reads: this file draws, `layout.tsx` decides.
 *
 * Its sibling used to live here too: `SidePane`, the right-hand panel, with two widths and three
 * modes of covering the conversation. The dock replaced all of it — every pane including the
 * conversation is now a leaf in one tree, and a tree needs no arbitration between its branches.
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
