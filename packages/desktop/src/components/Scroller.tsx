import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * The app's only scrolling surface.
 *
 * Three things the native scroller does not do, and which the reference has everywhere:
 *
 *   - a scrollbar that overlays the content instead of reserving a gutter, so nothing
 *     reflows sideways the moment a list grows past its box;
 *   - edges that dissolve while there is more to see, which reads as "keep going" without
 *     spending a row on a hint;
 *   - a hairline under a fixed header, appearing only once the content has moved under it.
 *
 * `overscroll-contain` keeps a wheel that reaches the end here rather than passing it to the
 * window behind — a nested list would otherwise scroll its parent as soon as it bottomed out.
 */
export function Scroller({
	children,
	className = "",
	contentClassName = "",
	/** Fade the top and bottom edges while there is more content that way. */
	fade = true,
	/** Draw a hairline at the top once the content has scrolled under whatever sits above. */
	divider = false,
	onScroll,
	scrollRef,
	fadeColor,
}: {
	children: React.ReactNode;
	className?: string;
	contentClassName?: string;
	fade?: boolean;
	divider?: boolean;
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

	const showTopFade = fade && metrics.overflow && !metrics.atTop;
	const showBottomFade = fade && metrics.overflow && !metrics.atBottom;

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

			{/* Hairline under a fixed header, only once something has passed beneath it. */}
			{divider && (
				<div
					aria-hidden
					className="pointer-events-none absolute inset-x-0 top-0 h-px bg-line transition-opacity duration-200"
					style={{ opacity: metrics.atTop ? 0 : 1 }}
				/>
			)}

			<div
				aria-hidden
				className="pointer-events-none absolute inset-x-0 top-0 h-8 transition-opacity duration-200"
				style={{
					opacity: showTopFade ? 1 : 0,
					background: "linear-gradient(to bottom, var(--ly-fade-color, var(--color-shell)), transparent)",
				}}
			/>
			<div
				aria-hidden
				className="pointer-events-none absolute inset-x-0 bottom-0 h-10 transition-opacity duration-200"
				style={{
					opacity: showBottomFade ? 1 : 0,
					background: "linear-gradient(to top, var(--ly-fade-color, var(--color-shell)), transparent)",
				}}
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
					className="absolute top-0 right-0 bottom-0 z-20 w-[10px]"
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
