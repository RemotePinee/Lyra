import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * A fade that has no edge in it.
 *
 * Two colour stops give a linear ramp in alpha, and a linear ramp in alpha does not look linear:
 * the eye is far more sensitive to change in the sparse end, so the gradient appears to hold its
 * colour and then stop, and where it stops reads as a faint rule somebody drew. That "虚线" above
 * the composer was never a border — it was this, the end of a two-stop gradient.
 *
 * These stops trace an ease-out curve instead, so the alpha falls fastest where the fade is
 * densest and trails off to nothing. There is no point along it where the rate of change jumps,
 * which is what it takes for a fade to read as a fade rather than as a band with a boundary.
 *
 * `color-mix` rather than baking in an rgba: the colour arrives as `--ly-fade-color` and is a
 * different surface on every pane it is used in.
 */
function fadeTo(direction: "top" | "bottom"): string {
	const base = "var(--ly-fade-color, var(--color-shell))";
	const at = (percent: number, position: number) =>
		`color-mix(in srgb, ${base} ${percent}%, transparent) ${position}%`;
	return [
		`linear-gradient(to ${direction}`,
		`${base} 0%`,
		at(94, 14),
		at(80, 28),
		at(60, 43),
		at(38, 59),
		at(19, 74),
		at(6, 88),
		"transparent 100%)",
	].join(", ");
}

/**
 * The app's only scrolling surface.
 *
 * Three things the native scroller does not do, and which the reference has everywhere:
 *
 *   - a scrollbar that overlays the content instead of reserving a gutter, so nothing
 *     reflows sideways the moment a list grows past its box;
 *   - an edge that says more is hidden that way, drawn as whatever the boundary actually is:
 *     a fade where content dissolves into empty space, a hairline where it slides under
 *     something solid. See `top` — picking the wrong one is what makes a list look broken.
 *
 * `overscroll-contain` keeps a wheel that reaches the end here rather than passing it to the
 * window behind — a nested list would otherwise scroll its parent as soon as it bottomed out.
 */
export function Scroller({
	children,
	className = "",
	contentClassName = "",
	top = "fade",
	bottom = "fade",
	onScroll,
	scrollRef,
	fadeColor,
}: {
	children: React.ReactNode;
	className?: string;
	contentClassName?: string;
	/**
	 * How the top edge ends — and these are two different physical situations, not two styles.
	 *
	 * `"fade"` is content dissolving into nothing: what sits above the scroller is the same empty
	 * surface the gradient fades to, so the softness reads as "there is more this way".
	 *
	 * `"line"` is content passing *under* something solid — a nav, a header, a toolbar. There the
	 * gradient is wrong twice over. It leaves half-lit rows hanging below an opaque block, which
	 * looks like a rendering fault rather than a hint, and it contradicts the boundary: a hairline
	 * says "this is an edge" while a fade says "this dissolves". The sidebar had both switched on
	 * at once, which is exactly what that ghosted row under the nav was. Solid things clip; only
	 * emptiness fades.
	 *
	 * The hairline appears only once something has actually gone under, so a short list has no
	 * rule at all — the boundary is only worth drawing when it is doing something.
	 */
	top?: "fade" | "line" | "none";
	/**
	 * Same question at the bottom, minus the hairline: nothing is ever pinned below the content.
	 *
	 * The test is whether what follows reaches the edge. A composer or a comment box is a rounded
	 * card with the pane's own colour all around it, so content really is scrolling away into
	 * empty space and should fade. A settings row with a `border-t` across the full width is a
	 * wall — content passes behind it, and a gradient stacked on its border draws one boundary
	 * twice.
	 */
	bottom?: "fade" | "none";
	/** The surface behind the content, so the edge gradients dissolve into it rather than
	 *  into the default shell colour. */
	fadeColor?: string;
	onScroll?: (element: HTMLDivElement) => void;
	/** Exposed for callers that drive the scroll position themselves, like the transcript. */
	scrollRef?: React.RefObject<HTMLDivElement | null>;
}) {
	const own = useRef<HTMLDivElement>(null);
	const viewport = scrollRef ?? own;
	const track = useRef<HTMLDivElement>(null);
	const drag = useRef<{ startY: number; startTop: number } | null>(null);

	const [metrics, setMetrics] = useState({ thumbTop: 0, thumbHeight: 0, overflow: false, atTop: true, atBottom: true });
	const [active, setActive] = useState(false);

	const measure = useCallback(() => {
		const el = viewport.current;
		if (!el) return;
		const { scrollTop, scrollHeight, clientHeight } = el;
		const overflow = scrollHeight - clientHeight > 1;
		// A thumb shorter than this is impossible to grab; it stops tracking exactly once the
		// content is very long, which is a fair trade for staying usable.
		const thumbHeight = overflow ? Math.max(28, (clientHeight / scrollHeight) * clientHeight) : 0;
		const travel = clientHeight - thumbHeight;
		const progress = scrollHeight - clientHeight <= 0 ? 0 : scrollTop / (scrollHeight - clientHeight);
		setMetrics({
			thumbTop: travel * progress,
			thumbHeight,
			overflow,
			atTop: scrollTop <= 1,
			atBottom: scrollTop >= scrollHeight - clientHeight - 1,
		});
	}, [viewport]);

	useLayoutEffect(() => {
		const el = viewport.current;
		if (!el) return;
		measure();

		// Both are needed: the box changes when the window resizes, and the content changes
		// when messages stream in or a list is filtered.
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		for (const child of el.children) observer.observe(child);

		const mutations = new MutationObserver(measure);
		mutations.observe(el, { childList: true, subtree: true, characterData: true });

		return () => {
			observer.disconnect();
			mutations.disconnect();
		};
	}, [measure, viewport]);

	// Dragging continues outside the thumb, so the listeners live on the window.
	useEffect(() => {
		if (!drag.current && !active) return;
		const onMove = (event: MouseEvent) => {
			const el = viewport.current;
			const state = drag.current;
			if (!el || !state) return;
			const travel = el.clientHeight - metrics.thumbHeight;
			if (travel <= 0) return;
			const ratio = (event.clientY - state.startY) / travel;
			el.scrollTop = state.startTop + ratio * (el.scrollHeight - el.clientHeight);
		};
		const onUp = () => {
			drag.current = null;
			setActive(false);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		return () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
		};
	}, [active, metrics.thumbHeight, viewport]);

	// Both only mean anything once something is actually hidden that way.
	const hiddenAbove = metrics.overflow && !metrics.atTop;
	const showTopFade = top === "fade" && hiddenAbove;
	const showTopLine = top === "line" && hiddenAbove;
	const showBottomFade = bottom === "fade" && metrics.overflow && !metrics.atBottom;

	return (
		<div
			style={fadeColor ? ({ "--ly-fade-color": fadeColor } as React.CSSProperties) : undefined}
			className={`ly-scroll-host relative flex min-h-0 flex-col ${className}`}
		>
			<div
				ref={viewport}
				onScroll={(event) => {
					measure();
					onScroll?.(event.currentTarget);
				}}
				/*
				 * A flex child, not `height: 100%`.
				 *
				 * `height: 100%` needs a parent with a *resolved* height. Given one bounded by
				 * `max-height` instead — which is how every menu here is sized — it resolves to
				 * `auto`, the viewport grows with its content, and nothing scrolls: the branch
				 * list simply ran off the bottom of its own menu. Percentage `max-height` fails
				 * the same way, for the same reason. Making the host a flex column and this its
				 * item hands the sizing to the flex algorithm, which honours both a fixed height
				 * and a `max-height` — so one Scroller works in a pane and in a popover.
				 */
				className={`ly-scroll-view min-h-0 flex-auto overflow-y-auto overscroll-contain ${contentClassName}`}
			>
				{children}
			</div>

			{top === "line" && (
				<div
					aria-hidden
					className="pointer-events-none absolute inset-x-0 top-0 h-px bg-line transition-opacity duration-200"
					style={{ opacity: showTopLine ? 1 : 0 }}
				/>
			)}

			<div
				aria-hidden
				className="pointer-events-none absolute inset-x-0 top-0 h-9 transition-opacity duration-200"
				style={{ opacity: showTopFade ? 1 : 0, background: fadeTo("bottom") }}
			/>
			<div
				aria-hidden
				className="pointer-events-none absolute inset-x-0 bottom-0 h-12 transition-opacity duration-200"
				style={{ opacity: showBottomFade ? 1 : 0, background: fadeTo("top") }}
			/>

			{metrics.overflow && (
				<div
					ref={track}
					/*
					 * Above anything the content pins.
					 *
					 * A sticky header inside the viewport sits in the same stacking context as this
					 * track, so without a higher layer the header slid over the thumb and the one
					 * control that tells you where you are in a long list disappeared.
					 */
					/*
					 * Inset by `--ly-scroll-inset` where something else owns the edge.
					 *
					 * A resizable pane puts a drag handle on its last 9 pixels, at a higher layer than
					 * this. Sharing them means the thumb is visible and permanently unusable: the press
					 * that should have grabbed it starts a resize. The pane declares how much edge is
					 * spoken for and the track steps inside it.
					 */
					style={{ right: "var(--ly-scroll-inset, 0px)" }}
					className="absolute top-0 bottom-0 z-20 w-[10px]"
					onMouseDown={(event) => {
						// Clicking the track jumps to that spot, then hands over to the drag.
						if (event.target !== track.current) return;
						const el = viewport.current;
						if (!el) return;
						const rect = track.current.getBoundingClientRect();
						const travel = el.clientHeight - metrics.thumbHeight;
						const ratio = (event.clientY - rect.top - metrics.thumbHeight / 2) / Math.max(1, travel);
						el.scrollTop = Math.min(1, Math.max(0, ratio)) * (el.scrollHeight - el.clientHeight);
					}}
				>
					{/* Hidden from assistive technology: the viewport underneath is what scrolls. */}
					<div
						aria-hidden
						tabIndex={-1}
						onMouseDown={(event) => {
							event.preventDefault();
							const el = viewport.current;
							if (!el) return;
							drag.current = { startY: event.clientY, startTop: el.scrollTop };
							setActive(true);
						}}
						style={{ top: metrics.thumbTop, height: metrics.thumbHeight }}
						className={`ly-thumb absolute right-[2px] w-[6px] rounded-full bg-ink-faint ${active ? "ly-thumb-active" : ""}`}
					/>
				</div>
			)}
		</div>
	);
}
