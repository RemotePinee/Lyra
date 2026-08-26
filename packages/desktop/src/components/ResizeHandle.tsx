import { useEffect, useRef, useState } from "react";

/**
 * How far the pointer can wander from the edge and still be grabbing it.
 *
 * Almost all of it on the far side of the boundary — see `INSIDE`.
 */
const HIT_WIDTH = 9;
/**
 * How much of that strip lies within the pane being resized.
 *
 * One pixel, and it is there so the boundary itself is grabbable rather than only the content
 * beside it. The rest hangs over the neighbour.
 *
 * The reason is the scrollbar. A pane's scroller puts its thumb on the last few pixels of the same
 * edge, and a thumb is only reachable while its scroller is hovered — which a pointer resting on
 * the handle is not doing. Sharing the strip therefore does not merely make the two compete; it
 * makes the scrollbar draggable or not depending on which direction the pointer arrived from,
 * because approaching across the list hovers the scroller on the way in and approaching from the
 * content does not. No z-order fixes that. Stepping the hit area over to the other side does, and
 * costs nothing visible: the thumb occupies pixels 2 through 8 measured from the pane's edge, so
 * one pixel of overlap leaves them disjoint.
 */
const INSIDE = 1;
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
 * The target straddles the boundary with almost all of it on the neighbour's side, which is what
 * keeps it clear of the scrollbar inside the pane — see `INSIDE`. Whoever renders this has to give
 * it a positioning context that does not clip: a pane clips its own overflow, so a handle hanging
 * outside one would simply be cut off. `NavPane` wraps the pane in a frame for exactly that.
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
	onPreview,
	onReset,
	label,
}: {
	/** Which side of the pane this is on: `end` for a left-hand pane, `start` for a right-hand one. */
	edge: "start" | "end";
	width: number;
	min: number;
	max: number;
	/**
	 * The width to keep. Called once when the drag ends, and on every keypress.
	 *
	 * With `onPreview` supplied this is the *commit* — the point at which the number is worth
	 * putting into state and onto disk.
	 */
	onResize: (next: number) => void;
	/**
	 * Every frame of the drag, when the caller can show the new width without React.
	 *
	 * This exists because of what the alternative costs. Routing each frame through `onResize`
	 * means a `setState` per frame, and the sidebar's width lives in a context whose value is
	 * memoised on it — so a new context value is produced sixty times a second and every consumer
	 * re-renders, transcript included. On a long conversation that is the whole frame budget spent
	 * before the browser has laid anything out, which is what the judder was.
	 *
	 * A caller that can write a CSS variable instead gets the same pixels with no React work at
	 * all. Optional: without it, `onResize` runs per frame exactly as before.
	 */
	onPreview?: (next: number) => void;
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
	/**
	 * Tears down a drag that `onMouseDown` started.
	 *
	 * The drag is armed in the event handler rather than in an effect, and this is what the effect
	 * would otherwise have returned. Held in a ref so the unmount path can still reach it.
	 */
	const release = useRef<(() => void) | null>(null);

	/**
	 * Arm the drag: listeners, cursor, and the flag that freezes transitions.
	 *
	 * Called synchronously from `onMouseDown`, which is the entire point. It used to live in an
	 * effect keyed on `active`, so pressing the edge only armed anything after `setState` had gone
	 * round through a render — and every `mousemove` that arrived in the meantime was delivered to
	 * nothing. Recorded frame by frame, the pane sat still for two frames and then jumped three
	 * frames' worth in one: the lurch you feel at the start of every drag, and the reason it read
	 * as juddering rather than as lag.
	 *
	 * Reads its props from the closure it was created in. They are fixed for the length of a drag
	 * in every case that matters — the one exception is a window resized mid-drag, where `max`
	 * would go stale until the pointer is released.
	 */
	const arm = () => {
		/*
		 * One update per frame, not one per event.
		 *
		 * `mousemove` fires faster than the screen refreshes — noticeably so on a 120Hz trackpad —
		 * and this handler did three expensive things every time: a `setState` that re-renders the
		 * whole window, a `getBoundingClientRect` that forces layout synchronously, and a second
		 * `setState`. Several of those inside one frame is a layout thrash, and with a multi-pane
		 * dock on the other side of the drag it showed up as the panes juddering while the handle
		 * moved smoothly.
		 *
		 * Coalescing to `requestAnimationFrame` means the work happens exactly as often as it can
		 * be seen, and the measurement happens at the point in the frame where layout is settled
		 * anyway.
		 */
		let frame = 0;
		let pending: MouseEvent | null = null;
		/** The last width shown, so the commit at the end is the width on screen. */
		let latest: number | null = null;

		const apply = () => {
			frame = 0;
			const event = pending;
			pending = null;
			if (!event) return;

			const travel = event.clientX - start.current.x;
			const next = edge === "end" ? start.current.width + travel : start.current.width - travel;
			latest = Math.min(max, Math.max(min, next));
			(onPreview ?? onResize)(latest);
			/*
			 * The grip tracks vertically while dragging, so it stays under the pointer.
			 *
			 * Only when it is being drawn: with a preview in play this `setState` would be the one
			 * piece of React work left in the frame, and it re-renders the pane the handle sits in.
			 */
			const box = track.current?.getBoundingClientRect();
			if (box) setGrip(Math.min(box.height, Math.max(0, event.clientY - box.top)));
		};

		const onMove = (event: MouseEvent) => {
			pending = event;
			if (!frame) frame = requestAnimationFrame(apply);
		};
		/*
		 * Let go of the grip too, unless the pointer came to rest back on the edge.
		 *
		 * A drag almost always ends somewhere else — that is the point of it — and `mouseleave`
		 * cannot report that, because the pointer left this element long before the button came up.
		 */
		const stop = (event: MouseEvent) => {
			teardown();
			setActive(false);
			/*
			 * Commit what is on screen.
			 *
			 * Only meaningful with a preview: without one every frame already went through
			 * `onResize` and state is current. With one, this is the first and only time the width
			 * becomes React state and reaches storage.
			 */
			if (onPreview && latest !== null) onResize(latest);
			if (!over(track.current, event)) setGrip(null);
		};

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

		function teardown() {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", stop);
			// A drag that ends mid-frame leaves nothing scheduled against an unmounted handle.
			if (frame) cancelAnimationFrame(frame);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			delete document.documentElement.dataset.resizing;
			release.current = null;
		}
		return teardown;
	};

	// Nothing left armed behind a handle that goes away mid-drag.
	useEffect(() => () => release.current?.(), []);

	/*
	 * `mouseleave` is not enough to know the pointer has gone.
	 *
	 * It is not delivered when the pointer crosses the whole element between two frames — a quick
	 * flick past a nine-pixel strip does exactly that — and it is not delivered at all when the
	 * pointer leaves the window, which is the case somebody notices: the grip stays lit on an edge
	 * nothing is near, and nothing will ever come along to put it out.
	 *
	 * So the question is asked the other way round. While a grip is showing, every pointer move
	 * anywhere re-checks whether it is still over this strip, and leaving the document or the
	 * window at all settles it immediately. Only while not dragging — during a drag the pointer is
	 * meant to be far away and the grip is meant to follow it.
	 */
	useEffect(() => {
		if (grip === null || active) return;
		const check = (event: MouseEvent) => {
			if (!over(track.current, event)) setGrip(null);
		};
		const gone = () => setGrip(null);
		// `mouseout` with no relatedTarget is the pointer crossing the window's own boundary.
		const out = (event: MouseEvent) => {
			if (!event.relatedTarget) gone();
		};
		window.addEventListener("mousemove", check);
		document.addEventListener("mouseout", out);
		window.addEventListener("blur", gone);
		return () => {
			window.removeEventListener("mousemove", check);
			document.removeEventListener("mouseout", out);
			window.removeEventListener("blur", gone);
		};
	}, [grip, active]);

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
				/*
				 * Armed here, before the state that redraws the grip.
				 *
				 * The listeners have to exist by the time the next `mousemove` arrives, and that can
				 * be the very next event — sooner than any render. Waiting for one is what made every
				 * drag begin with a stall and then a jump.
				 */
				release.current?.();
				release.current = arm();
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
			// Pushed out by everything except `INSIDE`, so the strip lands beyond the pane's edge.
			style={{ width: HIT_WIDTH, [edge === "end" ? "right" : "left"]: INSIDE - HIT_WIDTH }}
			className="group/resize absolute top-0 bottom-0 z-30 cursor-col-resize [--ly-grip:30px]"
		>
			{/*
			 * The grip: a short rounded bar centred on the pointer, pinned to the boundary itself.
			 *
			 * The boundary is now the *near* edge of this strip rather than its far one, because the
			 * strip stepped over to the neighbour's side. Drawn there rather than in the middle of
			 * the hit area, so what appears under the pointer is still the seam between two panes
			 * and not a mark floating in the content.
			 *
			 * Clamped away from the ends so it never collides with the window controls above or
			 * the status row below — at those extremes it stops travelling rather than sliding out
			 * of the pane.
			 */}
			{grip !== null && (
				<span
					aria-hidden
					style={{ top: `clamp(${GRIP_HEIGHT / 2 + 8}px, ${grip}px, calc(100% - ${GRIP_HEIGHT / 2 + 8}px))` }}
					className={`absolute h-[var(--ly-grip)] w-[3px] -translate-y-1/2 rounded-full transition-colors duration-[var(--ly-t-quick)] ${
						edge === "end" ? "left-0" : "right-0"
					} ${active ? "bg-accent" : "bg-ink-faint/45"}`}
				/>
			)}
		</div>
	);
}

/** Whether a pointer event landed within an element's box. Null element counts as "no". */
function over(element: HTMLElement | null, event: MouseEvent): boolean {
	if (!element) return false;
	const box = element.getBoundingClientRect();
	return (
		event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom
	);
}
