/**
 * The app's toasts. One surface, one set of rules, mounted once.
 *
 * They used to be drawn inside `<main>`, pinned above the composer. That was fine while the only
 * thing raising one was the conversation, and wrong the moment the file panel started raising
 * them: `main` is one column of a three-column row, so a notice about a file was clipped at the
 * panel's edge, printed on the far side of the window from the tree it was about, and underneath a
 * panel that outranks it. A message saying "that move is not allowed" cannot be something the
 * window can hide.
 *
 * So: a portal to `<body>`, fixed to the window, above every other layer, centred at the top. The
 * top because it is the one band that stays clear in all four arrangements — panel closed, panel
 * beside, panel full screen, compact — and because the composer, the tree and the editor all live
 * below it. Centred because a toast raised by the panel and one raised by the conversation are the
 * same kind of thing and should not appear in two different places.
 *
 * Everything about *which* cards exist is in `stack.ts`; this file is the drawing, the clock and
 * the pointer.
 */

import { CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useApp } from "../../store.ts";
import { groupNotices, TOAST_LIFETIME, TOAST_Z, visibleToasts, type ToastGroup } from "./stack.ts";

/** Matches `.ly-toast-out` in the stylesheet; the card is removed once it has played. */
const LEAVE_MS = 170;

/** How often the clock is read. Coarse on purpose — nobody can see a toast leave 200ms early. */
const TICK_MS = 200;

const TONE = {
	info: { Icon: Info, edge: "border-line", mark: "text-ink-faint" },
	warn: { Icon: TriangleAlert, edge: "border-accent/40", mark: "text-accent" },
	error: { Icon: CircleAlert, edge: "border-danger/45", mark: "text-danger" },
} as const;

export function Toaster() {
	const notices = useApp((s) => s.notices);
	const remove = useApp((s) => s.dismissNotice);

	const groups = useMemo(() => groupNotices(notices), [notices]);
	const shown = useMemo(() => visibleToasts(groups), [groups]);

	/*
	 * Held on screen for the length of the exit animation.
	 *
	 * The store drops a notice the moment it is dismissed, and a card that has left the array
	 * cannot animate — React has already unmounted it. Marking it first, removing it after, is what
	 * gives the animation something to play on.
	 */
	const [leaving, setLeaving] = useState<string[]>([]);

	const dismiss = useCallback(
		(group: ToastGroup) => {
			setLeaving((current) => (current.includes(group.key) ? current : [...current, group.key]));
			const ids = [...group.ids];
			setTimeout(() => {
				for (const id of ids) remove(id);
				setLeaving((current) => current.filter((key) => key !== group.key));
			}, LEAVE_MS);
		},
		[remove],
	);

	/*
	 * When each card is due, and a clock that reads it rather than a timer per card.
	 *
	 * A `setTimeout` each would have to be torn down and rebuilt on every change to the list — and
	 * the list changes whenever anything anywhere raises a notice, which is how a card ends up
	 * living twice as long as it should. A deadline is a fact about the card; the tick is the only
	 * thing that has to be scheduled.
	 */
	const due = useRef(new Map<string, number>());
	/** Set while the pointer is over the stack. Hovering stops the clock, so a long one is readable. */
	const [held, setHeld] = useState(false);
	const heldSince = useRef(0);

	useEffect(() => {
		const now = Date.now();
		const live = new Set(groups.map((group) => group.key));
		for (const key of due.current.keys()) if (!live.has(key)) due.current.delete(key);
		for (const group of groups) {
			// A repeat re-arms the clock: the message is current again, so its time starts again.
			const stamp = now + TOAST_LIFETIME[group.level];
			const existing = due.current.get(group.key);
			if (existing === undefined || stamp > existing) due.current.set(group.key, stamp);
		}
		// Counted rather than compared, so a repeat of an identical message still re-arms above.
	}, [groups]);

	useEffect(() => {
		if (groups.length === 0) return;
		const tick = window.setInterval(() => {
			if (held) return;
			const now = Date.now();
			for (const group of groups) {
				const deadline = due.current.get(group.key);
				if (deadline !== undefined && deadline <= now) dismiss(group);
			}
		}, TICK_MS);
		return () => window.clearInterval(tick);
	}, [groups, held, dismiss]);

	/** Give back the time the pointer took, so hovering pauses rather than merely delaying. */
	const release = useCallback(() => {
		const paused = Date.now() - heldSince.current;
		if (heldSince.current > 0 && paused > 0) {
			for (const [key, deadline] of due.current) due.current.set(key, deadline + paused);
		}
		heldSince.current = 0;
		setHeld(false);
	}, []);

	const hold = useCallback(() => {
		if (heldSince.current === 0) heldSince.current = Date.now();
		setHeld(true);
	}, []);

	if (shown.length === 0) return null;

	return createPortal(
		/*
		 * `TOAST_Z` puts this over the panel (50), the menus (60), the toolbar (61) and the image
		 * viewer (100/120). `no-drag` in case the stack ever grows up into the title bar's band, and
		 * `pointer-events-none` on the column so only the cards themselves take the pointer.
		 */
		<div
			style={{ zIndex: TOAST_Z }}
			className="no-drag pointer-events-none fixed inset-x-0 top-[52px] flex flex-col items-center gap-1.5 px-4"
		>
			{shown.map((group) => {
				const tone = TONE[group.level];
				return (
					<div
						key={group.key}
						/*
						 * `alert` for the ones that are about something going wrong, `status` for the
						 * rest — the difference is whether a screen reader interrupts what it is
						 * saying, and for progress chatter from a sub-agent it should not.
						 */
						role={group.level === "error" ? "alert" : "status"}
						onMouseEnter={hold}
						onMouseLeave={release}
						onFocusCapture={hold}
						onBlurCapture={release}
						/*
						 * No `shadow-*`: `ly-glass-solid` carries the lift every floating surface in the
						 * app uses, and a Tailwind shadow on top would replace it with a different one.
						 * It is also what makes this legible in both themes — an opaque surface built
						 * from the theme's own tokens rather than a tint over whatever is behind.
						 */
						className={`ly-glass-solid pointer-events-auto flex max-w-[min(560px,calc(100vw-3rem))] items-start gap-2 rounded-[13px] border py-1.5 pr-1.5 pl-2.5 text-detail text-ink ${
							leaving.includes(group.key) ? "ly-toast-out" : "ly-toast-in"
						} ${tone.edge}`}
					>
						{/* The colour lives on the mark, not on the words: a paragraph of red on pink is
						    the least legible way to say something went wrong. */}
						<tone.Icon size={13} strokeWidth={2} className={`mt-[2.5px] shrink-0 ${tone.mark}`} />
						<span className="min-w-0 leading-[18px] break-words">{group.message}</span>
						{/* Said once with a count, rather than the same card three times over. */}
						{group.ids.length > 1 && (
							<span className="mt-[1px] shrink-0 rounded-full bg-card-hover px-1.5 text-caption text-ink-muted tabular-nums">
								×{group.ids.length}
							</span>
						)}
						{/*
						 * Centred on the first line, not on the message.
						 *
						 * `items-start` puts the row's children at the top, and a 12px glyph at the top
						 * of an 18px line sits visibly above the text it belongs to. Giving the button
						 * the line's own height centres it there — and keeps it on the first line when
						 * the message wraps, which is where a dismiss control belongs.
						 */}
						<button
							type="button"
							onClick={() => dismiss(group)}
							className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-card-hover hover:text-ink"
							data-ly-tip="关闭"
							aria-label="关闭"
						>
							<X size={12} strokeWidth={2} />
						</button>
					</div>
				);
			})}
		</div>,
		document.body,
	);
}
