import { useEffect, useRef, useState } from "react";

/** How far the pointer can wander from the edge and still be grabbing it. */
const HIT_WIDTH = 9;
/** Keyboard resizing, per press. Shift multiplies it, the way nudging does everywhere else. */
const STEP = 16;

/**
 * The draggable edge of a pane.
 *
 * A 1px line is the correct thing to *see* and an impossible thing to hit, so the target is 9px
 * wide with the line drawn along its outer edge. The target lies wholly inside the pane rather
 * than straddling the boundary: the sidebar clips its own overflow, and half a handle hanging
 * outside would simply be cut off. Nothing is visible until the pointer arrives, which keeps a
 * still window free of chrome — the same rule the scrollbars follow.
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
	const [active, setActive] = useState(false);
	const start = useRef({ x: 0, width: 0 });

	useEffect(() => {
		if (!active) return;

		const onMove = (event: MouseEvent) => {
			const travel = event.clientX - start.current.x;
			const next = edge === "end" ? start.current.width + travel : start.current.width - travel;
			onResize(Math.min(max, Math.max(min, next)));
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
			className="group/resize absolute top-0 bottom-0 z-30 cursor-col-resize"
		>
			{/* The line itself: one pixel on the boundary, and only there when wanted. */}
			<span
				className={`absolute inset-y-0 w-px transition-colors duration-150 ${
					edge === "end" ? "right-0" : "left-0"
				} ${active ? "bg-accent" : "bg-transparent group-hover/resize:bg-line"}`}
			/>
		</div>
	);
}
