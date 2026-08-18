/**
 * Picking a pane up, carrying it, and putting it down.
 *
 * Three decisions define how this feels, and all three are here:
 *
 * **The layout rearranges live.** The tree is committed the moment the pointer crosses into a new
 * landing region, not on release — so what you are looking at while you drag is the layout you
 * will get, not a hint about it. Committing on region changes rather than per frame is what makes
 * that affordable: a terminal re-measures itself once per region crossed instead of sixty times a
 * second.
 *
 * **The hit test reads the tree, never the DOM.** The panes are mid-transition for most of a drag,
 * so `getBoundingClientRect` would answer with wherever they happen to have got to — and the
 * landing region would be computed from a position that is already stale. The tree is authoritative
 * and costs nothing to measure.
 *
 * **The pane itself is what lifts.** Not a stand-in card that follows the pointer — that reads as
 * cheap, because it is: an empty rectangle with a title, while the thing you are actually moving
 * sits greyed out underneath. A pane *is* its contents, and the only way to carry those without
 * mounting a second copy — a second shell, a second page — is to move the one that exists. So the
 * pane switches from `absolute` in the dock to `fixed` against the window and back, which changes
 * no element and recreates nothing.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { dropAt, sameDrop, type Rect } from "./drop.ts";
import { DRAG_THRESHOLD, paneFloor } from "./geometry.ts";
import { fitTree, layoutPanes } from "./layout.ts";
import { useDock } from "./store.ts";
import { lift, type PaneKind } from "./tree.ts";

/**
 * A backstop for the landing, well past `--ly-t-base`.
 *
 * The flight normally ends on its own `transitionend`. This is for the cases where that event
 * never arrives: reduced motion turns the transition off entirely, and a pane whose destination is
 * where it already is has nothing to animate. Generous, because ending the flight early is the
 * failure that matters — the pane is handed back to the dock mid-flight, the dock's own transition
 * picks up the remaining few pixels, and what should have been one movement is visibly two.
 */
const LAND_TIMEOUT_MS = 700;

/** The pane in the air: which one, where, and whether it is on its way home. */
export interface Carried {
	kind: PaneKind;
	rect: Rect;
	landing: boolean;
}

interface Held {
	kind: PaneKind;
	/** The pane's box when the press began — the ghost's size for the whole drag. */
	from: Rect;
	/** Where inside the pane it was grabbed, so it hangs off the pointer where it was picked up. */
	grip: { x: number; y: number };
	origin: { x: number; y: number };
	pointerId: number;
	target: HTMLElement;
}

export function useDockDrag(containerRef: React.RefObject<HTMLElement | null>): {
	carried: Carried | null;
	start: (kind: PaneKind, event: React.PointerEvent<HTMLElement>) => void;
	/** Called by the carried pane when its flight home finishes. */
	landed: () => void;
} {
	const [carried, setCarried] = useState<Carried | null>(null);
	const held = useRef<Held | null>(null);
	/** False until the pointer has travelled far enough for this to be a drag rather than a click. */
	const moving = useRef(false);
	const landingTimer = useRef<number | undefined>(undefined);
	/** So the backstop timer and the transition both end the flight the same way. */
	const settle = useRef<() => void>(() => {});

	/** Where a pane is right now, in client coordinates, according to the tree. */
	const rectOf = useCallback(
		(kind: PaneKind): Rect | null => {
			const container = containerRef.current?.getBoundingClientRect();
			if (!container) return null;
			// Fitted, because that is where the pane actually is on screen — see `fitTree`.
			const box = layoutPanes(fitTree(useDock.getState().tree, container, paneFloor)).find((pane) => pane.kind === kind);
			if (!box) return null;
			return {
				left: container.left + box.left * container.width,
				top: container.top + box.top * container.height,
				width: box.width * container.width,
				height: box.height * container.height,
			};
		},
		[containerRef],
	);

	/**
	 * Fly the pane to a box and hand it back to the dock when it gets there.
	 *
	 * Two frames, deliberately. Turning the transition on and changing the position in one commit
	 * usually animates, but "usually" depends on how the browser batched the style recalculation —
	 * and the failure mode is a hard cut, which is precisely the bug this app has shipped before.
	 * Setting `landing` first and the box on the next frame cannot be batched into one.
	 *
	 * The box it flies to is the one the tree already puts it at, so releasing it back to `absolute`
	 * at the end moves it by nothing.
	 */
	const landAt = useCallback((rect: Rect | null) => {
		setCarried((current) => (current ? { ...current, landing: true } : null));
		requestAnimationFrame(() => {
			setCarried((current) => (current && rect ? { ...current, rect } : current));
			window.clearTimeout(landingTimer.current);
			landingTimer.current = window.setTimeout(() => settle.current(), LAND_TIMEOUT_MS);
		});
	}, []);

	/**
	 * The flight is over: hand the pane back to the dock.
	 *
	 * Driven by the pane's own `transitionend` rather than by a timer, because a timer has to guess
	 * how long the transition took to *start* — and two `requestAnimationFrame`s on a busy frame is
	 * not a fixed quantity. Guessing short hands the pane back while it is still moving, the dock's
	 * own transition takes over the remaining distance, and one movement becomes two.
	 */
	const landed = useCallback(() => {
		window.clearTimeout(landingTimer.current);
		/*
		 * Suppress the dock's own transition for the frame that hands the pane back.
		 *
		 * Carried, the pane is `fixed` and positioned in pixels against the window. Docked, it is
		 * `absolute` and positioned in percentages against the dock. Those describe the same place
		 * — but they are not the same *values*, and a transition interpolates values, not places.
		 * `left: 272px` re-read against the dock instead of the window is a point 272px further
		 * right, so the pane animated in from somewhere it had never been: one clean flight home
		 * followed by a second, wrong, drift.
		 */
		document.documentElement.dataset.dockSettling = "";
		setCarried(null);
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				delete document.documentElement.dataset.dockSettling;
			});
		});
	}, []);

	const finish = useCallback(
		(cancelled: boolean) => {
			const grabbed = held.current;
			held.current = null;
			if (!grabbed) return;
			try {
				grabbed.target.releasePointerCapture(grabbed.pointerId);
			} catch {
				// The element may already be gone, or never have had the capture. Nothing to undo.
			}
			if (!moving.current) return;
			moving.current = false;
			delete document.documentElement.dataset.dockDragging;
			useDock.getState().endDrag(cancelled);
			// Cancelling restores the tree, so home is where the pane started; otherwise it is
			// wherever the live rearrangement has already put it. Read after `endDrag` either way.
			landAt(cancelled ? grabbed.from : rectOf(grabbed.kind));
		},
		[landAt, rectOf],
	);

	const start = useCallback((kind: PaneKind, event: React.PointerEvent<HTMLElement>) => {
		if (event.button !== 0) return;
		const pane = (event.target as HTMLElement).closest?.("[data-dock-pane]") as HTMLElement | null;
		if (!pane) return;
		const box = pane.getBoundingClientRect();
		const target = event.currentTarget;
		held.current = {
			kind,
			from: { left: box.left, top: box.top, width: box.width, height: box.height },
			grip: { x: event.clientX - box.left, y: event.clientY - box.top },
			origin: { x: event.clientX, y: event.clientY },
			pointerId: event.pointerId,
			target,
		};
		/*
		 * Capture on the header, not the window.
		 *
		 * A pane can hold a <webview> or an <iframe>, which is a separate document that swallows
		 * the pointer the instant it crosses into one — and a drag that dies halfway across the
		 * window leaves the ghost stranded. Capture routes every move back here regardless of
		 * what is underneath. `data-dock-dragging` additionally turns off hit testing inside the
		 * panes, which is what covers the out-of-process case capture cannot reach.
		 */
		try {
			target.setPointerCapture(event.pointerId);
		} catch {
			// Not fatal: the window listeners below still see the drag.
		}
	}, []);

	useEffect(() => {
		const onMove = (event: PointerEvent) => {
			const grabbed = held.current;
			if (!grabbed || event.pointerId !== grabbed.pointerId) return;

			if (!moving.current) {
				const travelled = Math.hypot(event.clientX - grabbed.origin.x, event.clientY - grabbed.origin.y);
				if (travelled < DRAG_THRESHOLD) return;
				const before = useDock.getState().tree;
				const rest = lift(before, grabbed.kind);
				// The only pane in the dock has nowhere to be dropped, so it is not picked up.
				if (!rest) {
					held.current = null;
					return;
				}
				moving.current = true;
				// Freezes the panes' box transitions and stops the pointer reaching pane contents.
				document.documentElement.dataset.dockDragging = "";
				useDock.getState().beginDrag({
					kind: grabbed.kind,
					from: grabbed.from,
					grip: grabbed.grip,
					pointer: { x: event.clientX, y: event.clientY },
					at: null,
					before,
					rest,
				});
				// Lift it out straight away: the pane is in the air now, and the ones staying put
				// close over the space it left.
				useDock.getState().preview(rest, grabbed.kind, null);
			}

			setCarried({
				kind: grabbed.kind,
				rect: {
					left: event.clientX - grabbed.grip.x,
					top: event.clientY - grabbed.grip.y,
					width: grabbed.from.width,
					height: grabbed.from.height,
				},
				landing: false,
			});

			const container = containerRef.current?.getBoundingClientRect();
			const drag = useDock.getState().drag;
			if (!container || !drag) return;
			const root: Rect = { left: container.left, top: container.top, width: container.width, height: container.height };

			/*
			 * Hit-tested against the layout without the carried pane, not against what is drawn.
			 *
			 * The preview rearranges things, so testing against the current layout makes each answer
			 * depend on the one before it — the pointer sits still while the pane under it changes
			 * shape, crosses into a different band, and the layout flips back and forth. `rest` is
			 * fixed for the whole drag, so one pointer position means one thing throughout; and
			 * because the carried pane really is out of the dock, `rest` is also what the panes
			 * staying put are actually drawn at.
			 */
			const panes = layoutPanes(fitTree(drag.rest, container, paneFloor)).map((pane) => ({
				kind: pane.kind,
				box: {
					left: container.left + pane.left * container.width,
					top: container.top + pane.top * container.height,
					width: pane.width * container.width,
					height: pane.height * container.height,
				},
			}));

			const at = dropAt(root, panes, event.clientX, event.clientY);
			// The rearrangement happens here, and only when the answer has actually changed —
			// including when it changes back to nothing, which puts the starting layout back.
			if (!sameDrop(at, drag.at)) useDock.getState().preview(drag.rest, grabbed.kind, at);
			useDock.getState().dragTo({ x: event.clientX, y: event.clientY }, at);
		};

		const onUp = (event: PointerEvent) => {
			if (held.current && event.pointerId !== held.current.pointerId) return;
			finish(false);
		};
		const onCancel = () => finish(true);
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || !held.current) return;
			// Before anything else can act on it: an abandoned drag is what Escape means here.
			event.preventDefault();
			event.stopPropagation();
			finish(true);
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onCancel);
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onCancel);
			window.removeEventListener("keydown", onKey, true);
			window.clearTimeout(landingTimer.current);
			delete document.documentElement.dataset.dockDragging;
		};
	}, [containerRef, finish]);

	settle.current = landed;

	return { carried, start, landed };
}
