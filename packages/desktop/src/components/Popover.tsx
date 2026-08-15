/**
 * A popover anchored to the element that opened it.
 *
 * Menus that belong to a control should appear next to that control, not in the middle of the
 * window — the centred dialog loses the connection between what you clicked and what opened.
 * Position is measured from the trigger's rect and flipped when it would run off screen.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * A point to hang a menu from, for right-click — where the thing being acted on is a whole
 * row and the only meaningful position is the cursor itself.
 */
export interface PointAnchor {
	x: number;
	y: number;
}

export type Anchor = HTMLElement | PointAnchor | null;

function rectOf(anchor: Anchor): DOMRect | null {
	if (!anchor) return null;
	if (anchor instanceof HTMLElement) return anchor.getBoundingClientRect();
	// A zero-size rect at the cursor: every placement rule below already works off a rect.
	return new DOMRect(anchor.x, anchor.y, 0, 0);
}

export interface PopoverProps {
	/** The element the popover is attached to, or a point for a context menu. */
	anchor: Anchor;
	onClose: () => void;
	children: React.ReactNode;
	/**
	 * Preferred side. Flips automatically when there is not enough room.
	 *
	 * `right` puts the menu beside its trigger instead of under it, which matters for a row in
	 * a list: a menu that drops downward covers the rows you were about to compare it against.
	 */
	placement?: "top" | "bottom" | "right";
	/** Which edge of the popover lines up with the anchor. */
	align?: "start" | "end" | "center";
	width?: number;
	className?: string;
}

const GAP = 8;
const MARGIN = 12;

/**
 * The column a popover belongs to, so it does not spill into the one next door.
 *
 * A menu opened from the composer belongs over the conversation. Clamped only to the window, a
 * wide one ran out under the side panel beside it — half of it hidden, and the visible half
 * sitting in a region it has nothing to do with. The layout's three columns are the natural
 * boundary: whichever one the trigger is in is where the menu stays.
 *
 * Null for a point anchor (a right-click) and whenever the menu simply cannot fit in its
 * column — being clipped is worse than overlapping.
 */
function columnBounds(anchor: Anchor, width: number): { left: number; right: number } | null {
	if (!(anchor instanceof HTMLElement)) return null;
	const column = anchor.closest("main, aside, .dw-panel");
	if (!column) return null;
	const rect = column.getBoundingClientRect();
	return rect.width - 8 < width ? null : { left: rect.left + 4, right: rect.right - 4 };
}

/**
 * Every open popover, so a new one can close the others as it mounts.
 *
 * Right-clicking a second row used to leave the first menu on screen — and worse, the first
 * one's pending exit timer would then fire and close the *new* menu 120ms later. One at a
 * time, enforced at the point of mounting, removes both.
 */
const openPopovers = new Set<{ close: () => void }>();

export function Popover({
	anchor,
	onClose,
	children,
	placement = "top",
	align = "end",
	width,
	className = "",
}: PopoverProps) {
	const ref = useRef<HTMLDivElement>(null);
	const [style, setStyle] = useState<React.CSSProperties>({ opacity: 0, left: 0, top: 0 });
	const [side, setSide] = useState<"top" | "bottom" | "right">(placement);
	/**
	 * Set while the exit animation plays, before the caller is told to unmount.
	 *
	 * A menu that simply disappears on the frame you click outside it reads as a glitch; the
	 * eye needs the same 120ms going out that it got coming in.
	 */
	const [leaving, setLeaving] = useState(false);
	/**
	 * False until the popover knows where it goes.
	 *
	 * It mounts at 0,0 and only learns its position once it has been measured. Playing the
	 * entrance animation before then ran the first frames in the corner of the window and
	 * snapped to the anchor mid-flight, which is the jump.
	 */
	const [placed, setPlaced] = useState(false);
	const closed = useRef(false);
	const exitTimer = useRef<number | undefined>(undefined);

	// Dismissal always runs the exit first. Guarded so a click and an Escape in quick
	// succession cannot schedule two unmounts.
	const dismiss = useCallback(() => {
		if (closed.current) return;
		closed.current = true;
		setLeaving(true);
		exitTimer.current = window.setTimeout(onClose, 120);
	}, [onClose]);

	/*
	 * A new anchor means this popover was re-opened; cancel any exit already in flight.
	 *
	 * Right-clicking while a menu is open fires `mousedown` before `contextmenu`. The
	 * mousedown lands outside the menu and starts the exit; the contextmenu then re-anchors
	 * it — and 120ms later the stale timer closed the menu that had just opened. It looked
	 * like right-click did nothing.
	 */
	useEffect(() => {
		closed.current = false;
		setLeaving(false);
		window.clearTimeout(exitTimer.current);
	}, [anchor]);

	// A pending exit must not outlive the component either.
	useEffect(() => () => window.clearTimeout(exitTimer.current), []);

	// One menu at a time. Registered on mount, so opening this one dismisses whatever was up.
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	useLayoutEffect(() => {
		const self = { close: () => onCloseRef.current() };
		for (const other of openPopovers) other.close();
		openPopovers.clear();
		openPopovers.add(self);
		return () => {
			openPopovers.delete(self);
		};
	}, []);

	// Measure after paint: the popover's own size decides whether it fits above the anchor.
	useLayoutEffect(() => {
		const element = ref.current;
		if (!anchor || !element) return;

		const measure = () => {
			const a = rectOf(anchor);
			if (!a) return;
			const box = element.getBoundingClientRect();
			// A menu wider than the window cannot be nudged into view — it has to give up width.
			const limit = window.innerWidth - MARGIN * 2;
			const w = Math.min(width ?? box.width, limit);

			const fitsAbove = a.top - box.height - GAP >= MARGIN;
			const fitsBelow = a.bottom + box.height + GAP <= window.innerHeight - MARGIN;

			// Stay inside the trigger's own column when it has room, otherwise inside the window.
			const column = columnBounds(anchor, w);
			const minLeft = Math.max(MARGIN, column ? column.left : MARGIN);
			const maxLeft = Math.min(window.innerWidth - MARGIN, column ? column.right : window.innerWidth - MARGIN) - w;
			const clampX = (x: number) => Math.min(Math.max(minLeft, x), Math.max(minLeft, maxLeft));

			let left: number;
			/*
			 * Which edge is pinned, not just where the card starts.
			 *
			 * A card that opens upwards used to be placed by `top: anchor.top - height`, computed
			 * from the height it happened to have when it was measured. Content that arrives
			 * afterwards — a breakdown replacing its skeleton rows — makes it taller, and since
			 * the top edge is nailed down it grows *downwards*, over the trigger that opened it.
			 * Pinning `bottom` to the trigger instead makes it grow away from it, so late content
			 * moves the far edge and never the near one.
			 */
			let anchorEdge: { top: number } | { bottom: number };
			let resolved: "top" | "bottom" | "right";

			if (placement === "right") {
				// Beside the trigger, aligned to its top edge, nudged up only if it would run off
				// the bottom of the window. Falls back to the left side when there is no room.
				resolved = "right";
				const fitsRight = a.right + GAP + w <= maxLeft + w;
				left = clampX(fitsRight ? a.right + GAP : a.left - GAP - w);
				anchorEdge = { top: Math.min(Math.max(MARGIN, a.top - 4), window.innerHeight - box.height - MARGIN) };
			} else {
				resolved =
					placement === "top" ? (fitsAbove || !fitsBelow ? "top" : "bottom") : fitsBelow || !fitsAbove ? "bottom" : "top";
				left = clampX(align === "start" ? a.left : align === "center" ? a.left + a.width / 2 - w / 2 : a.right - w);
				anchorEdge =
					resolved === "top" ? { bottom: window.innerHeight - a.top + GAP } : { top: a.bottom + GAP };
			}

			setSide(resolved);

			setPlaced(true);
			setStyle({
				left,
				...anchorEdge,
				// Leave intrinsic width intrinsic; only cap it, so content changes still reflow.
				width,
				maxWidth: limit,
				// Capped at the gap it was placed in, so content arriving later scrolls inside the
				// card rather than pushing its far edge off the screen.
				maxHeight:
					resolved === "top"
						? a.top - GAP - MARGIN
						: resolved === "bottom"
							? window.innerHeight - a.bottom - GAP - MARGIN
							: window.innerHeight - MARGIN * 2,
				opacity: 1,
			});
		};

		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [anchor, align, placement, width]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				dismiss();
			}
		};
		const onPointerDown = (event: MouseEvent) => {
			const target = event.target as Node;
			// Clicking the trigger again is its own toggle; do not double-handle it here.
			if (ref.current?.contains(target)) return;
			if (anchor instanceof HTMLElement && anchor.contains(target)) return;
			dismiss();
		};
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("mousedown", onPointerDown, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("mousedown", onPointerDown, true);
		};
	}, [anchor, dismiss]);

	return (
		<div
			ref={ref}
			role="menu"
			style={style}
			/*
			 * Above everything, including the side panel.
			 *
			 * Both used to be z-50, so the winner was whichever came later in the DOM — the
			 * panel — and a menu opened near it was simply cut in half. A popover is transient
			 * and belongs on top of whatever it was opened over, always.
			 */
			className={`dw-glass dw-scroll-host dw-scroll-view fixed z-[60] overflow-x-hidden overflow-y-auto rounded-[10px] border border-line ${
				leaving
					? "dw-pop-out"
					: placed
						? side === "top"
							? "dw-pop-up"
							: side === "right"
								? "dw-pop-right"
								: "dw-pop-down"
						: ""
			} ${className}`}
		>
			{children}
		</div>
	);
}

/** Track an anchor element and its open state, the pair every popover trigger needs. */
export function usePopover() {
	const [anchor, setAnchor] = useState<Anchor>(null);
	return {
		anchor,
		open: Boolean(anchor),
		toggle: (event: React.MouseEvent<HTMLElement>) => {
			const target = event.currentTarget;
			setAnchor((current) => (current === target ? null : target));
		},
		/** Open against a specific element. */
		openAt: (element: HTMLElement) => setAnchor(element),
		/** Open at the cursor — right-click acts on a whole row, so the row is not the anchor. */
		openAtPoint: (event: React.MouseEvent) => setAnchor({ x: event.clientX, y: event.clientY }),
		close: () => setAnchor(null),
	};
}

/*
 * Re-exported so the twenty callers that import a menu row from here keep working.
 *
 * The definitions moved to `Menu.tsx`; a popover is a positioned surface and a menu is what is
 * often put on one, which is a relationship rather than an identity.
 */
export { MenuBody, MenuItem, MenuLabel, MenuSeparator } from "./Menu.tsx";
