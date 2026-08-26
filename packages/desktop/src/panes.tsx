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
	/** The frame whose width the drag writes directly; see the handle's `onPreview`. */
	const frame = useRef<HTMLDivElement>(null);
	/** The window-drag strip, which has to keep the same width. Found once, on first preview. */
	const band = useRef<HTMLElement | null>(null);
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
			 * Which form it is in, so the fill can differ — see `[data-pane="drawer"]` in the
			 * stylesheet. Beside the content the pane is a column of its own; as a drawer it lies
			 * over the transcript and has to cover what is under it.
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
		/*
		 * `width` eases too, which it did not before.
		 *
		 * Only the ways of changing it that are *not* a drag ever see this. Double-clicking the
		 * handle, nudging it with the arrow keys, or a window that narrowed past what both panes
		 * need all move the edge in one step, and a step is the thing an ease is for — the content
		 * beside it reflows once, on the way, instead of snapping between two paragraph shapes.
		 *
		 * A drag is the opposite case and is already covered: `ResizeHandle` sets `data-resizing`
		 * on <html> for its duration, which zeroes every transition in the document, so the edge
		 * tracks the pointer instead of easing toward each intermediate width and never arriving.
		 */
		<div
			ref={frame}
			className={`relative shrink-0 ${
				snap ? "transition-none" : "transition-[margin-left,opacity,width] duration-[var(--ly-t-base)] ease-out"
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
					/*
					 * Every frame writes the two elements that show the width; only the last one
					 * becomes state.
					 *
					 * Written onto the elements themselves rather than into a variable on `:root`.
					 * Both express the same pixels, and they cost very different amounts: a custom
					 * property on the root is inherited by the whole document, so setting one
					 * invalidates style for every node in it. Measured over the same drag, that was
					 * a median frame of 28.5ms against 16.7ms for touching two elements — worse
					 * than the `setState` it was meant to replace.
					 *
					 * React overwrites both on the next render, which is exactly what commits the
					 * drag: the value it writes is the one this last previewed.
					 */
					onPreview={(next) => {
						const px = `${Math.round(next)}px`;
						if (frame.current) frame.current.style.width = px;
						band.current ??= document.querySelector<HTMLElement>("[data-ly-drag-band]");
						if (band.current) band.current.style.width = px;
					}}
					onResize={setSidebarWidth}
					onReset={resetSidebarWidth}
					label="调整侧边栏宽度"
				/>
			)}
		</div>
	);
}
