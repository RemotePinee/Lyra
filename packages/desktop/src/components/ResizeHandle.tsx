import { useEffect, useRef, useState } from "react";

/**
 * How far the pointer can wander from the edge and still be grabbing it.
 *
 * Exported because a scroller inside a resizable pane has to keep out of this strip. Both used to
 * sit on the same 9 pixels of edge with the handle on top, so the scrollbar was drawn, could be
 * seen, and could never be grabbed — every press within reach of it started a resize instead.
 */
export const RESIZE_HIT_WIDTH = 9;
const HIT_WIDTH = RESIZE_HIT_WIDTH;
/** Keyboard resizing, per press. Shift multiplies it, the way nudging does everywhere else. */
const STEP = 16;
/** Long enough to read as a grab handle, short enough not to read as a border. */
const GRIP_HEIGHT = 30;

/**
 * The draggable edge of a pane.
 *
 * What appears is a short grip at the pointer, not a rule down the whole edge. A full-height line
 * reads as a border — a permanent piece of the layout — when the thing it means is "this
 * particular spot can be dragged". A grip that follows the pointer says that and nothing else,
 * and it leaves the boundary looking the same whether or not you happen to be near it.
 *
 * The 9px target lies wholly inside the pane rather than straddling the boundary: the sidebar
 * clips its own overflow, and half a handle hanging outside would simply be cut off.
 *
 * Reports an absolute width rather than a delta, computed from where the drag started. Summing
 * deltas per mousemove accumulates the clamping error: drag past the minimum, come back, and the
 * pane is short by however far past it you went.
 */
export function ResizeHandle({
	edge,
	width,
	min,
	max,
	onResize,
	onReset,
	label,
}: {
	/** Which side of the pane this is on: `end` for a left-hand pane, `start` for a right-hand one. */
	edge: "start" | "end";
	width: number;
	min: number;
	max: number;
	onResize: (next: number) => void;
	/** Double-click restores the default. */
	onReset?: () => void;
	label: string;
}) {
	const track = useRef<HTMLDivElement>(null);
	const [active, setActive] = useState(false);
	/*
	 * Where along the edge the grip sits, in pixels from the top of the handle.
	 *
	 * Null until the pointer arrives, so nothing is drawn on a pane nobody is reaching for. Held
	 * as state rather than read from a CSS variable because it also has to survive the drag: once
	 * the pointer leaves the 9px strip the handle stops receiving moves, and a grip that vanished
	 * mid-drag would leave you dragging an invisible edge.
	 */
	const [grip, setGrip] = useState<number | null>(null);
	const start = useRef({ x: 0, width: 0 });

	useEffect(() => {
		if (!active) return;

		const onMove = (event: MouseEvent) => {
			const travel = event.clientX - start.current.x;
			const next = edge === "end" ? start.current.width + travel : start.current.width - travel;
			onResize(Math.min(max, Math.max(min, next)));
			// The grip tracks vertically while dragging, so it stays under the pointer.
			const box = track.current?.getBoundingClientRect();
			if (box) setGrip(Math.min(box.height, Math.max(0, event.clientY - box.top)));
		};
		const stop = () => setActive(false);

		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", stop);
		/*
		 * The cursor and the selection guard go on <body>, not on the handle.
		 *
		 * Once a drag is under way the pointer spends most of its time over the panes on either
		 * side, and a `cursor` on the handle only applies while the pointer is actually over it —
		 * so it would flicker back to a text caret the moment the drag left the 9px strip.
		 */
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		// Freezes transitions for the length of the drag, so the pane tracks the pointer instead
		// of easing towards each intermediate width and never arriving.
		document.documentElement.dataset.resizing = "";

		return () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", stop);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			delete document.documentElement.dataset.resizing;
		};
	}, [active, edge, min, max, onResize]);

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuenow={Math.round(width)}
			aria-valuemin={min}
			aria-valuemax={max}
			tabIndex={0}
			ref={track}
			onMouseEnter={(event) => setGrip(event.clientY - event.currentTarget.getBoundingClientRect().top)}
			onMouseMove={(event) => {
				if (active) return;
				setGrip(event.clientY - event.currentTarget.getBoundingClientRect().top);
			}}
			onMouseLeave={() => {
				// Stays put while dragging: the pointer is usually well outside the strip by then.
				if (!active) setGrip(null);
			}}
			onMouseDown={(event) => {
				// Left button only: a right-click here should not start a silent drag.
				if (event.button !== 0) return;
				event.preventDefault();
				start.current = { x: event.clientX, width };
				setActive(true);
			}}
			onDoubleClick={onReset}
			onKeyDown={(event) => {
				const step = event.shiftKey ? STEP * 4 : STEP;
				// Arrows move the edge itself, so left always narrows a left-hand pane.
				const grow = edge === "end" ? "ArrowRight" : "ArrowLeft";
				const shrink = edge === "end" ? "ArrowLeft" : "ArrowRight";
				if (event.key === grow) onResize(Math.min(max, width + step));
				else if (event.key === shrink) onResize(Math.max(min, width - step));
				else if (event.key === "Home") onReset?.();
				else return;
				event.preventDefault();
			}}
			style={{ width: HIT_WIDTH, [edge === "end" ? "right" : "left"]: 0 }}
			className="group/resize absolute top-0 bottom-0 z-30 cursor-col-resize [--ly-grip:30px]"
		>
			{/*
			 * The grip: a short rounded bar centred on the pointer, pinned to the boundary itself.
			 *
			 * Clamped away from the ends so it never collides with the window controls above or
			 * the status row below — at those extremes it stops travelling rather than sliding out
			 * of the pane.
			 */}
			{grip !== null && (
				<span
					aria-hidden
					style={{ top: `clamp(${GRIP_HEIGHT / 2 + 8}px, ${grip}px, calc(100% - ${GRIP_HEIGHT / 2 + 8}px))` }}
					className={`absolute h-[var(--ly-grip)] w-[3px] -translate-y-1/2 rounded-full transition-colors duration-150 ${
						edge === "end" ? "right-[1px]" : "left-[1px]"
					} ${active ? "bg-accent" : "bg-ink-faint/45"}`}
				/>
			)}
		</div>
	);
}
