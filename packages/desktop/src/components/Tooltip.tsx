import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** How long the pointer has to rest before a tip appears. */
const DELAY_MS = 420;
/** Gap between the tip and the control it describes. */
const GAP = 6;

/**
 * The app's tooltip.
 *
 * Replaces the browser's `title`, which was doing this job in twenty-eight places. The native
 * one cannot be styled, waits about a second and a half, ignores the app's font and theme, and
 * on macOS renders as a system panel that looks like it belongs to another program entirely.
 *
 * Rendered in a portal so a tip on a control inside a scroller or a clipped panel is not cut
 * off by it — which is the other thing that makes people reach for `title` and give up.
 *
 * Deliberately not shown on focus. A keyboard user tabbing through a toolbar would get a tip
 * per stop, which is noise; the accessible name is on the button itself via `aria-label`.
 */
export function Tooltip({
	label,
	children,
	side = "bottom",
}: {
	label: React.ReactNode;
	children: React.ReactElement;
	side?: "top" | "bottom";
}) {
	const anchor = useRef<HTMLSpanElement>(null);
	const tip = useRef<HTMLDivElement>(null);
	const timer = useRef<number | undefined>(undefined);
	const [open, setOpen] = useState(false);
	const [style, setStyle] = useState<React.CSSProperties>({ opacity: 0 });

	useLayoutEffect(() => {
		if (!open) return;
		const host = anchor.current?.firstElementChild ?? anchor.current;
		const box = tip.current;
		if (!host || !box) return;

		const a = host.getBoundingClientRect();
		const b = box.getBoundingClientRect();
		// Flip rather than run off the top or bottom of the window.
		const below = side === "bottom" ? a.bottom + GAP : a.top - b.height - GAP;
		const fitsChosen = side === "bottom" ? below + b.height < window.innerHeight - 4 : below > 4;
		const top = fitsChosen ? below : side === "bottom" ? a.top - b.height - GAP : a.bottom + GAP;

		setStyle({
			top,
			left: Math.min(Math.max(6, a.left + a.width / 2 - b.width / 2), window.innerWidth - b.width - 6),
			opacity: 1,
		});
	}, [open, side]);

	// A tip left behind by a control that has gone — a menu closing, a row being filtered out —
	// would otherwise hang around with nothing under it.
	useEffect(() => () => window.clearTimeout(timer.current), []);

	const show = () => {
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setOpen(true), DELAY_MS);
	};
	const hide = () => {
		window.clearTimeout(timer.current);
		setOpen(false);
		setStyle({ opacity: 0 });
	};

	return (
		<>
			<span ref={anchor} className="contents" onMouseEnter={show} onMouseLeave={hide} onMouseDown={hide}>
				{children}
			</span>

			{open &&
				createPortal(
					<div
						ref={tip}
						role="tooltip"
						style={style}
						className="dw-tooltip pointer-events-none fixed z-[100] max-w-[260px] rounded-md px-2 py-1 text-[11.5px] whitespace-nowrap"
					>
						{label}
					</div>,
					document.body,
				)}
		</>
	);
}
