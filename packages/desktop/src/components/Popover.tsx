/**
 * A popover anchored to the element that opened it.
 *
 * Menus that belong to a control should appear next to that control, not in the middle of the
 * window — the centred dialog loses the connection between what you clicked and what opened.
 * Position is measured from the trigger's rect and flipped when it would run off screen.
 *
 * The surface is three slots rather than one: `header` and `footer` stay put while the middle
 * scrolls. Before that existed, a menu needing a search field put one inside its scrolling area
 * and then had to keep it from scrolling away — which two menus solved twice, differently, and a
 * third avoided by never scrolling at all.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Scroller } from "./Scroller.tsx";

/**
 * A point to hang a menu from, for right-click — where the thing being acted on is a whole
 * row and the only meaningful position is the cursor itself.
 */
interface PointAnchor {
	x: number;
	y: number;
}

export type Anchor = HTMLElement | PointAnchor | null;

/**
 * The widths a floating surface is allowed to be.
 *
 * There were twelve of them between 184 and 288, and no two menus that look alike agreed on one —
 * so the same gesture in the sidebar and in the composer produced panels four pixels apart for a
 * reason nobody could state. Four sizes, chosen by what the surface holds rather than by how long
 * its longest label happened to be on the day it was written.
 */
export const MENU_WIDTH = {
	/** Actions only, a word or two each. */
	compact: 190,
	/** The ordinary menu — icon, label, sometimes a second line — and every dropdown. */
	default: 224,
	/** Anything with a search field, or a list long enough to scroll. */
	wide: 272,
	/** Not a menu: a reading, a slider, a form. */
	panel: 300,
} as const;

export type PopoverWidth = keyof typeof MENU_WIDTH | number;

/**
 * How tall a menu that lists things is allowed to get.
 *
 * Left to the window, a project menu on a tall display runs from the composer to the top of the
 * screen — technically correct, and a list of forty rows nobody reads to the end of. The three
 * menus that scroll each picked their own ceiling (280, 300, 320) for the same reason; this is
 * that reason, stated once.
 */
export const MENU_MAX_HEIGHT = 340;

function widthOf(width: PopoverWidth | undefined): number | undefined {
	if (width === undefined) return undefined;
	return typeof width === "number" ? width : MENU_WIDTH[width];
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
	width?: PopoverWidth;
	/**
	 * Pinned above the scrolling body — a search field, a heading.
	 *
	 * Kept out of `children` because it must not scroll: a filter that leaves the screen the
	 * moment you use it is one you have to scroll back up to correct.
	 */
	header?: React.ReactNode;
	/** Pinned below it, for an action that stays reachable however long the list gets. */
	footer?: React.ReactNode;
	/** Ceiling for a surface that would otherwise grow to fill the window — see `MENU_MAX_HEIGHT`. */
	maxHeight?: number;
	/**
	 * What this surface is, for anything reading the window rather than looking at it.
	 *
	 * It used to be hard-coded to `menu` — right for most of them, wrong for the three that are
	 * not: a rename form, a context reading, an effort slider. A text field announced as a menu
	 * item is worse than one announced as nothing.
	 */
	role?: "menu" | "listbox" | "dialog" | "group";
	/** Names the surface where its trigger does not. */
	label?: string;
	className?: string;
	/** Lands on the scrolling body, for surfaces that pad their own content. */
	bodyClassName?: string;
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
	const column = anchor.closest("main, aside, .ly-panel");
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
	header,
	footer,
	maxHeight,
	role = "menu",
	label,
	className = "",
	bodyClassName = "",
}: PopoverProps) {
	const ref = useRef<HTMLDivElement>(null);
	const [style, setStyle] = useState<React.CSSProperties>({ opacity: 0, left: 0, top: 0 });
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
			// A menu wider than the window cannot be nudged into view — it has to give up width.
			const limit = window.innerWidth - MARGIN * 2;
			const fixed = widthOf(width);
			/*
			 * Width first, then measure — because height depends on it.
			 *
			 * The width used to be handed over with the position, which is one frame too late: the
			 * first measurement read the height of content laid out at its *intrinsic* width, and a
			 * card whose text then wrapped at 300px came out taller than the box that had been
			 * placed for it. Whether it fits above the trigger was decided on the wrong number, and
			 * a panel that answered "yes" wrongly settled over the control it points at.
			 */
			if (fixed !== undefined) element.style.width = `${Math.min(fixed, limit)}px`;
			const box = element.getBoundingClientRect();
			const w = Math.min(fixed ?? box.width, limit);

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
			/** Placed by fitting it into the window rather than by hanging it off the anchor. */
			let shifted = false;
			/*
			 * Where the growth starts, in the popover's own coordinates.
			 *
			 * One keyframe scales up from a point, and the point is the corner nearest the trigger
			 * — worked out here because only this pass knows which way the surface flipped and how
			 * far it had to be clamped. It used to be a constant per direction, `top center` or
			 * `bottom center`, so a right-aligned menu hanging off a button in the corner grew out
			 * of its own middle and read as having appeared from nowhere rather than from the thing
			 * that was clicked.
			 */
			let origin: string;

			if (placement === "right") {
				// Beside the trigger, aligned to its top edge, nudged up only if it would run off
				// the bottom of the window. Falls back to the left side when there is no room.
				resolved = "right";
				const fitsRight = a.right + GAP + w <= maxLeft + w;
				left = clampX(fitsRight ? a.right + GAP : a.left - GAP - w);
				const top = Math.min(Math.max(MARGIN, a.top - 4), window.innerHeight - box.height - MARGIN);
				anchorEdge = { top };
				origin = `${fitsRight ? "0px" : "100%"} ${clamp(a.top + a.height / 2 - top, 0, box.height)}px`;
			} else {
				resolved =
					placement === "top" ? (fitsAbove || !fitsBelow ? "top" : "bottom") : fitsBelow || !fitsAbove ? "bottom" : "top";
				left = clampX(align === "start" ? a.left : align === "center" ? a.left + a.width / 2 - w / 2 : a.right - w);
				/*
				 * Neither side has room: slide it into the window rather than scroll inside it.
				 *
				 * This is what a native menu does. A right-click low in a long file tree opens a menu
				 * taller than the space beneath the cursor, and taller than the space above it too —
				 * and the answer is not to put a scrollbar in a list of eleven actions, it is to move
				 * the menu up until it fits. Scrolling here hides the items at the end, which for
				 * this menu are the destructive ones, behind a gesture nobody expects to need.
				 *
				 * Only when *both* sides fail. With room on either side the menu still hangs off the
				 * cursor, which is where the pointer expects to find it.
				 */
				shifted = !fitsAbove && !fitsBelow && box.height + MARGIN * 2 <= window.innerHeight;
				anchorEdge = shifted
					? { top: clamp(a.bottom + GAP, MARGIN, window.innerHeight - box.height - MARGIN) }
					: resolved === "top"
						? { bottom: window.innerHeight - a.top + GAP }
						: { top: a.bottom + GAP };
				origin = `${clamp(a.left + a.width / 2 - left, 0, w)}px ${resolved === "top" ? "100%" : "0px"}`;
			}

			setPlaced(true);
			setStyle({
				left,
				...anchorEdge,
				// Leave intrinsic width intrinsic; only cap it, so content changes still reflow.
				width: fixed,
				maxWidth: limit,
				transformOrigin: origin,
				// Capped at the gap it was placed in, so content arriving later scrolls inside the
				// card rather than pushing its far edge off the screen. A caller's own ceiling
				// only ever lowers it further.
				maxHeight: Math.min(
					// Shifted into place, the ceiling is the window rather than the gap it started from
					// — the gap is precisely what it stopped being bound by.
					shifted
						? window.innerHeight - MARGIN * 2
						: resolved === "top"
							? a.top - GAP - MARGIN
							: resolved === "bottom"
								? window.innerHeight - a.bottom - GAP - MARGIN
								: window.innerHeight - MARGIN * 2,
					maxHeight ?? Infinity,
				),
				opacity: 1,
			});
		};

		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [anchor, align, placement, width, maxHeight]);

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

	/*
	 * Frosted over the page, opaque over the sidebar.
	 *
	 * Under vibrancy the sidebar has no background at all — macOS draws the material *below* the web
	 * contents, so every layer from the sidebar up to `<html>` is transparent. There is nothing there
	 * for `backdrop-filter` to blur, and a 52% panel over nothing is 52% of nothing: the rows behind
	 * it simply show through, legibly, which is the one thing a menu must not allow.
	 *
	 * Blur cannot fix that, so this stops asking for it there and pays with an opaque fill instead.
	 * Over `main` — which does paint a background — the real thing still happens.
	 */
	const surface =
		anchor instanceof HTMLElement && anchor.closest("aside") && document.documentElement.dataset.vibrancy === "on"
			? "ly-glass-solid"
			: "ly-glass";

	/*
	 * Rendered into `<body>`, not where it was written.
	 *
	 * A popover is `position: fixed` and positioned from window coordinates, so where it sits in
	 * the tree never affected where it appeared — until it did. `backdrop-filter` samples what has
	 * been painted *inside the nearest backdrop root*, and a `mask` makes an element one. Every
	 * scroller in this app that softens its edges carries a mask, so a menu opened inside one was
	 * blurring that scroller's own transparent background instead of the page: the frosted panel
	 * kept its tint and its shadow and lost the blur, and the text underneath came through sharp.
	 *
	 * The same containment would eventually have clipped a menu against an ancestor's `overflow`
	 * as well. Both problems are the same problem — a transient layer that belongs on top of the
	 * window should not be a descendant of anything in it.
	 */
	return createPortal(
		<div
			ref={ref}
			role={role}
			aria-label={label}
			style={style}
			/*
			 * Above everything, including the side panel.
			 *
			 * Both used to be z-50, so the winner was whichever came later in the DOM — the
			 * panel — and a menu opened near it was simply cut in half. A popover is transient
			 * and belongs on top of whatever it was opened over, always.
			 */
			className={`${surface} fixed z-[60] flex flex-col overflow-hidden rounded-[10px] border border-line ${
				leaving ? "ly-pop-out" : placed ? "ly-pop-in" : ""
			} ${className}`}
		>
			{header && <div className="shrink-0 border-b border-line-soft">{header}</div>}

			{/*
			 * The app's own scroller, not `overflow: auto` — so a menu that outgrows the gap it was
			 * placed in gets the same overlaid bar and softened edge as every other list in the
			 * window. Three menus used to reach for `Scroller` themselves and the rest scrolled with
			 * a native bar; making it the surface's job is what makes the answer the same everywhere.
			 */}
			<Scroller className="min-h-0 flex-auto" contentClassName={`overflow-x-hidden ${bodyClassName}`}>
				{children}
			</Scroller>

			{footer && <div className="shrink-0 border-t border-line-soft">{footer}</div>}
		</div>,
		document.body,
	);
}

function rectOf(anchor: Anchor): DOMRect | null {
	if (!anchor) return null;
	if (anchor instanceof HTMLElement) return anchor.getBoundingClientRect();
	// A zero-size rect at the cursor: every placement rule below already works off a rect.
	return new DOMRect(anchor.x, anchor.y, 0, 0);
}

function clamp(value: number, low: number, high: number): number {
	return Math.min(Math.max(value, low), high);
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
export { MenuBody, MenuItem, MenuLabel, MenuSearch, MenuSeparator } from "./Menu.tsx";
