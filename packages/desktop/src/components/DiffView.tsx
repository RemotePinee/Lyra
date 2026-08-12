import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { DiffHunk } from "@deepwise/core";

/**
 * Unified diff, rendered the way the reference review panel does it: a gutter of line numbers,
 * a green rail on additions and a red rail on removals, and no syntax highlighting competing
 * with the change colours.
 *
 * Long lines scroll sideways, and that is the whole reason for the layering here. The rows sit
 * on a layer as wide as the longest line, so a tint or a separator runs the full length of what
 * it belongs to instead of stopping at the fold. The line numbers and the rail are pinned to the
 * left edge, because the moment a line is long enough to need scrolling is the moment you most
 * want to know which line you are on. Everything that is metadata rather than code — the hunk
 * headers, the truncation notice — is pinned as well, since scrolling it away helps nobody.
 */
export function DiffView({ hunks, path, maxLines = 600 }: { hunks: DiffHunk[]; path?: string; maxLines?: number }) {
	let emitted = 0;
	const scroller = useRef<HTMLDivElement>(null);

	return (
		<div className="dw-diff-host relative">
			<div ref={scroller} className="dw-diff-scroll overflow-x-auto font-mono text-[11.5px] leading-[1.65]">
				<div className="w-max min-w-full">
					{path && (
						<div className="sticky left-0 w-max border-b border-line-soft px-3 py-1.5 text-[11px] text-ink-faint">
							{path}
						</div>
					)}

					{hunks.map((hunk, hunkIndex) => (
						<div key={hunkIndex} className="border-b border-line-soft last:border-b-0">
							{hunkIndex > 0 && (
								<div className="sticky left-0 w-max bg-panel/60 px-3 py-0.5 text-[10.5px] text-ink-faint">
									@@ -{hunk.oldStart} +{hunk.newStart} @@
								</div>
							)}

							{hunk.lines.map((line, lineIndex) => {
								if (emitted >= maxLines) return null;
								emitted += 1;
								const added = line.type === "add";
								const removed = line.type === "remove";
								return (
									<div
										key={lineIndex}
										className={`flex ${added ? "dw-diff-add bg-ok/8" : removed ? "dw-diff-remove bg-danger/8" : ""}`}
									>
										{/* Pinned columns need an opaque fill of their own: the row's tint is
										    translucent, and the code would otherwise show through as it passes. */}
										<span className="dw-diff-gutter sticky left-0 z-[1] w-[42px] shrink-0 pr-2 text-right text-ink-faint/70 select-none">
											{line.newLine ?? line.oldLine ?? ""}
										</span>
										<span
											className={`sticky left-[42px] z-[1] w-[3px] shrink-0 ${
												added ? "bg-ok/70" : removed ? "bg-danger/70" : "dw-diff-rail"
											}`}
										/>
										<span
											className={`shrink-0 px-2.5 whitespace-pre ${
												added ? "text-ok" : removed ? "text-danger/90" : "text-ink-muted"
											}`}
										>
											{line.text || " "}
										</span>
									</div>
								);
							})}
						</div>
					))}

					{emitted >= maxLines && (
						<div className="sticky left-0 w-max px-3 py-1.5 text-[11px] text-ink-faint">
							… 差异过长，已截断显示
						</div>
					)}
				</div>
			</div>

			<HorizontalThumb viewport={scroller} />
		</div>
	);
}

/**
 * A sideways scrollbar, drawn rather than native.
 *
 * macOS hides overlay scrollbars until something moves, which on a diff is exactly backwards:
 * a long line that runs off the edge with no visible bar reads as truncated, and there is no
 * other cue, because nothing shifts until you already know to scroll. This stays put whenever
 * there is more to the right, and matches the overlay thumb the rest of the app draws.
 */
function HorizontalThumb({ viewport }: { viewport: React.RefObject<HTMLDivElement | null> }) {
	const track = useRef<HTMLDivElement>(null);
	const drag = useRef<{ startX: number; startLeft: number } | null>(null);
	const [metrics, setMetrics] = useState({ left: 0, width: 0, overflow: false });
	const [active, setActive] = useState(false);

	const measure = useCallback(() => {
		const el = viewport.current;
		if (!el) return;
		const { scrollLeft, scrollWidth, clientWidth } = el;
		const overflow = scrollWidth - clientWidth > 1;
		// Reserves the strip the thumb sits in, so it never covers the last line of code.
		el.dataset.hscroll = overflow ? "on" : "off";
		const width = overflow ? Math.max(32, (clientWidth / scrollWidth) * clientWidth) : 0;
		const travel = clientWidth - width;
		const progress = scrollWidth - clientWidth <= 0 ? 0 : scrollLeft / (scrollWidth - clientWidth);
		setMetrics({ left: travel * progress, width, overflow });
	}, [viewport]);

	useLayoutEffect(() => {
		const el = viewport.current;
		if (!el) return;
		measure();
		el.addEventListener("scroll", measure, { passive: true });
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		if (el.firstElementChild) observer.observe(el.firstElementChild);
		return () => {
			el.removeEventListener("scroll", measure);
			observer.disconnect();
		};
	}, [measure, viewport]);

	useEffect(() => {
		if (!active) return;
		const onMove = (event: MouseEvent) => {
			const el = viewport.current;
			const state = drag.current;
			if (!el || !state) return;
			const travel = el.clientWidth - metrics.width;
			if (travel <= 0) return;
			const ratio = (event.clientX - state.startX) / travel;
			el.scrollLeft = state.startLeft + ratio * (el.scrollWidth - el.clientWidth);
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
	}, [active, metrics.width, viewport]);

	if (!metrics.overflow) return null;

	return (
		<div
			ref={track}
			/*
			 * Sticky, not absolute, and relative to the vertical scroller outside this component.
			 *
			 * A diff can be hundreds of rows long; pinned to the bottom of the content it would
			 * only come into view once you had already scrolled past everything it was meant to
			 * help you read. The negative margin lets it sit on the strip the rows reserve at the
			 * end rather than adding height of its own.
			 */
			className="sticky bottom-0 z-[2] -mt-[10px] h-[10px]"
			onMouseDown={(event) => {
				if (event.target !== track.current) return;
				const el = viewport.current;
				if (!el || !track.current) return;
				const rect = track.current.getBoundingClientRect();
				const travel = el.clientWidth - metrics.width;
				const ratio = (event.clientX - rect.left - metrics.width / 2) / Math.max(1, travel);
				el.scrollLeft = Math.min(1, Math.max(0, ratio)) * (el.scrollWidth - el.clientWidth);
			}}
		>
			<div
				role="scrollbar"
				aria-orientation="horizontal"
				tabIndex={-1}
				onMouseDown={(event) => {
					event.preventDefault();
					const el = viewport.current;
					if (!el) return;
					drag.current = { startX: event.clientX, startLeft: el.scrollLeft };
					setActive(true);
				}}
				style={{ left: metrics.left, width: metrics.width }}
				className={`dw-hthumb absolute bottom-[2px] h-[6px] rounded-full bg-ink-faint ${active ? "dw-hthumb-active" : ""}`}
			/>
		</div>
	);
}
