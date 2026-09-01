/**
 * Fullscreen in-place screenshot overlay, drawn with the app's own annotator.
 *
 * Two coordinate spaces meet here and it is worth being explicit about which is which. The
 * selection and every pointer event are in CSS pixels, because that is what the overlay window is
 * measured in. The annotator works in the snapshot's own pixels, which on a Retina screen are twice
 * as many. `AnnotateCanvas` is therefore given an explicit CSS size — the display it is standing
 * on, at 1:1 — rather than being allowed to lay out at its bitmap's size, which would cover twice
 * the area it is meant to.
 *
 * The annotator is handed the *whole* snapshot, not a crop of the selection, and the selected
 * region is a window onto it: an absolutely positioned frame with the full-size canvas shifted
 * underneath it by the selection's own offset. That is what keeps marks anchored to the thing they
 * were drawn on when the selection is moved or resized afterwards — a crop would have to be
 * retaken on every drag, and every mark on it would slide.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ScreenshotSettings } from "@lyra/core";
import {
	AnnotateCanvas,
	AnnotateToolbar,
	useAnnotator,
} from "./Annotator.tsx";
import {
	clampRect,
	handlePoint,
	hitHandle,
	insideRect,
	moveRect,
	rectFromPoints,
	resizeRect,
	toolbarPosition,
	HANDLES,
	HANDLE_CURSOR,
	type Handle,
	type Point,
	type Rect,
} from "./screenshot-geometry.ts";

const HANDLE_GRAB = 10;
const TOOLBAR_SIZE = { width: 660, height: 48 };
const MIN_SELECTION = 10;
/**
 * How wide the band around the selection's edge is that picks the whole region up.
 *
 * While annotating, the inside of the selection belongs to the pen: a press there draws. The
 * region still has to be movable, so the grab is the border itself — the same place the eye
 * already reads as the edge of the shot, and the same convention every other capture tool uses.
 */
const EDGE_GRAB = 8;
/**
 * How long the dimming takes to arrive, and to leave.
 *
 * Short enough not to be a wait before you can drag, long enough to read as a transition rather
 * than a jump — the complaint being answered is a capture that appears all at once.
 */
const ENTER_MS = 160;
const LEAVE_MS = 120;

interface ScreenshotInit {
	snapshot: string;
	bounds: { x: number; y: number; width: number; height: number };
	scaleFactor: number;
	settings?: ScreenshotSettings;
}

type DragMode =
	| { kind: "none" }
	| { kind: "creating"; from: Point }
	| { kind: "moving"; from: Point; origin: Rect }
	| { kind: "resizing"; handle: Handle; origin: Rect };

/** Whether a point is on the selection's border rather than out in the middle of it. */
function onEdge(rect: Rect, at: Point, tolerance: number): boolean {
	if (!insideRect(rect, at)) return false;
	return (
		at.x - rect.x <= tolerance ||
		rect.x + rect.width - at.x <= tolerance ||
		at.y - rect.y <= tolerance ||
		rect.y + rect.height - at.y <= tolerance
	);
}

export function ScreenshotOverlay() {
	const [initData, setInitData] = useState<ScreenshotInit | null>(null);
	const [selection, setSelection] = useState<Rect | null>(null);
	const [dragMode, setDragMode] = useState<DragMode>({ kind: "none" });
	const [cursor, setCursor] = useState("crosshair");
	const [isAnnotating, setIsAnnotating] = useState(false);

	const bgCanvasRef = useRef<HTMLCanvasElement | null>(null);
	/** The toolbar's measured size, so it is kept on screen against what it really is. */
	const [toolbarSize, setToolbarSize] = useState<{ width: number; height: number } | null>(null);
	const measureToolbar = useCallback((el: HTMLDivElement | null) => {
		if (!el) return;
		const r = el.getBoundingClientRect();
		if (!r.width || !r.height) return;
		setToolbarSize((was) =>
			was && Math.abs(was.width - r.width) < 1 && Math.abs(was.height - r.height) < 1
				? was
				: { width: Math.ceil(r.width), height: Math.ceil(r.height) },
		);
	}, []);

	/*
	 * The whole screen, decoded once.
	 *
	 * The frozen backdrop below and the annotator both need this bitmap, and `useAnnotator` already
	 * loads it — so the backdrop is painted from *its* image rather than decoding the same data URL
	 * a second time. On a 5K display that is several megabytes and a visible fraction of the delay
	 * before the overlay can be shown at all.
	 */
	const annotator = useAnnotator(initData?.snapshot ?? "");
	const { ready: snapshotReady, image: snapshotImage } = annotator;

	// Receive initialization data from main process
	useEffect(() => {
		const cleanup = window.lyra?.screenshot?.onInit((data: ScreenshotInit) => {
			setInitData(data);
		});
		return cleanup;
	}, []);

	/*
	 * The frozen screen, at the resolution it was captured at.
	 *
	 * The backing store is the snapshot's own pixel count, not the display's logical size: sized
	 * logically, a Retina capture is squeezed to half resolution and then stretched back over the
	 * screen, and the first thing the user sees on pressing the shortcut is their desktop going
	 * blurry.
	 */
	useEffect(() => {
		if (!initData || !snapshotReady) return;
		const img = snapshotImage.current;
		const canvas = bgCanvasRef.current;
		if (!img || !canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		canvas.width = img.naturalWidth;
		canvas.height = img.naturalHeight;
		ctx.drawImage(img, 0, 0);

		/*
		 * Said straight away, and deliberately not after a `requestAnimationFrame`.
		 *
		 * Waiting for a frame would be the more careful-looking thing to do and it deadlocks: the
		 * window this runs in is hidden until this very message arrives, a hidden page is not
		 * composited, and a rAF callback in one never runs. The overlay would appear 1.5 seconds
		 * later off the failsafe timer, every time. It is also unnecessary — `drawImage` has already
		 * written the snapshot into the canvas's bitmap, so the first frame after `show()` has it.
		 */
		window.lyra?.screenshot?.ready?.();
	}, [initData, snapshotReady, snapshotImage]);

	/*
	 * The way in and the way out, as a fade rather than a cut.
	 *
	 * The frozen snapshot is not what fades — it is a picture of the screen it is covering, so
	 * showing it instantly is invisible by construction. What fades is the dimming and the hint,
	 * which is the part that says "you are in capture mode now": the screen darkens over a beat
	 * instead of the whole thing arriving in one frame.
	 *
	 * `entered` is driven by the main process rather than by a mount effect, because until the
	 * window is shown this page is not composited and a transition started here has no frames to
	 * run in — it would land on its end state immediately, which is the abruptness being removed.
	 */
	const [entered, setEntered] = useState(false);
	const [leaving, setLeaving] = useState(false);

	useEffect(() => {
		const cleanup = window.lyra?.screenshot?.onShown?.(() => setEntered(true));
		/*
		 * The main process is the only thing that knows, and `document.hidden` is not it.
		 *
		 * An Electron window that has never been shown still reports its document as visible — it is
		 * a window, not a background tab. Trusting that here set the end state before the window was
		 * on screen, so the transition had nothing left to run and capture mode arrived in one
		 * frame: the abruptness this is supposed to remove, reintroduced by the safety net.
		 *
		 * The timer is the real safety net. `reveal` sends the message from every path that shows
		 * the window, including the failsafe one, so this should never fire — and if it somehow
		 * does, an overlay that is a little abrupt beats one that is permanently invisible.
		 */
		const safety = setTimeout(() => setEntered(true), 2000);
		return () => {
			cleanup?.();
			clearTimeout(safety);
		};
	}, []);

	/**
	 * Play the way out, then do the thing. Guarded, so a second Escape cannot double-fire it.
	 *
	 * The guard is a ref and the timer is set outside any updater, which is not a style choice. A
	 * state updater has to be a pure function of the state — React calls it more than once per
	 * commit, and may not call it at all when the value it would return is the one already there.
	 * Scheduling the timer inside one is therefore a coin toss on whether the screenshot is ever
	 * delivered: press 完成, watch it fade, and stay in capture mode forever with nothing on the
	 * clipboard. Which is exactly what it did.
	 */
	const leavingRef = useRef(false);
	const leaveThen = useCallback((act: () => void) => {
		if (leavingRef.current) return;
		leavingRef.current = true;
		setLeaving(true);
		setTimeout(act, LEAVE_MS);
	}, []);

	// Cancel / close screenshot
	const handleCancel = useCallback(() => {
		leaveThen(() => window.lyra?.screenshot?.cancel?.());
	}, [leaveThen]);

	// Escape shortcut
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				handleCancel();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [handleCancel]);

	/**
	 * The selection and the marks on it, cut out of the annotated canvas at its own resolution.
	 *
	 * Read straight off the live canvas rather than through `render()` and a second decode: the
	 * canvas is already exactly the picture that is wanted, minus everything outside the frame.
	 */
	const handleFinish = useCallback(() => {
		const source = annotator.canvas.current;
		if (!source || !selection || !initData) return;

		const scale = source.width / initData.bounds.width;
		const out = document.createElement("canvas");
		out.width = Math.max(1, Math.round(selection.width * scale));
		out.height = Math.max(1, Math.round(selection.height * scale));
		const ctx = out.getContext("2d");
		if (!ctx) return;

		ctx.drawImage(
			source,
			Math.round(selection.x * scale),
			Math.round(selection.y * scale),
			out.width,
			out.height,
			0,
			0,
			out.width,
			out.height,
		);

		// Rendered before the fade, so the picture is of the marks and not of them half faded out.
		const png = out.toDataURL("image/png");
		leaveThen(() => window.lyra?.screenshot?.finish?.(png, initData.settings));
	}, [annotator, selection, initData, leaveThen]);

	// Selection pointer events
	const handlePointerDown = (e: React.PointerEvent) => {
		if (!initData) return;
		/*
		 * A press on a control is not a press on the screen.
		 *
		 * The toolbar floats *outside* the selection — below it, by `toolbarPosition` — so without
		 * this every press on it falls through to the rule at the bottom of this function and is
		 * read as "start a new region somewhere else". Pressing any tool button therefore threw the
		 * selection away and went back to the empty crosshair, which is the whole of "点一个按钮就
		 * 立马出现新的截图". Nothing about it is visible to a test that clicks buttons through the
		 * DOM: `element.click()` dispatches a click and no pointer event at all.
		 */
		if ((e.target as HTMLElement).closest?.("[data-screenshot-ui]")) return;
		const pt: Point = { x: e.clientX, y: e.clientY };

		if (selection) {
			const handle = hitHandle(selection, pt, HANDLE_GRAB);
			if (handle) {
				setDragMode({ kind: "resizing", handle, origin: selection });
				(e.target as HTMLElement).setPointerCapture(e.pointerId);
				return;
			}
			if (insideRect(selection, pt)) {
				// Before there is anything to annotate the whole region is a grab; afterwards only its
				// edge is, because the middle is the canvas.
				if (!isAnnotating || onEdge(selection, pt, EDGE_GRAB)) {
					setDragMode({ kind: "moving", from: pt, origin: selection });
					(e.target as HTMLElement).setPointerCapture(e.pointerId);
				}
				// Otherwise the press belongs to `AnnotateCanvas`, which has already had it.
				return;
			}
		}

		// Anywhere outside starts a new region, and abandons the marks made on the old one.
		setIsAnnotating(false);
		setDragMode({ kind: "creating", from: pt });
		setSelection({ x: pt.x, y: pt.y, width: 0, height: 0 });
		(e.target as HTMLElement).setPointerCapture(e.pointerId);
	};

	const handlePointerMove = (e: React.PointerEvent) => {
		if (!initData) return;
		const pt: Point = { x: e.clientX, y: e.clientY };

		if (dragMode.kind === "creating") {
			const rect = clampRect(rectFromPoints(dragMode.from, pt), initData.bounds);
			setSelection(rect);
		} else if (dragMode.kind === "moving") {
			const dx = pt.x - dragMode.from.x;
			const dy = pt.y - dragMode.from.y;
			const rect = moveRect(dragMode.origin, dx, dy, initData.bounds);
			setSelection(rect);
		} else if (dragMode.kind === "resizing") {
			const rect = clampRect(
				resizeRect(dragMode.origin, dragMode.handle, pt),
				initData.bounds,
			);
			setSelection(rect);
		} else if (selection) {
			// Update hover cursor
			const handle = hitHandle(selection, pt, HANDLE_GRAB);
			if (handle) {
				setCursor(HANDLE_CURSOR[handle]);
				return;
			}
			if (insideRect(selection, pt)) {
				// The canvas sets its own cursor for the tool in hand; this is only about the frame.
				setCursor(!isAnnotating || onEdge(selection, pt, EDGE_GRAB) ? "move" : "default");
				return;
			}
			setCursor("crosshair");
		} else {
			setCursor("crosshair");
		}
	};

	const handlePointerUp = () => {
		if (dragMode.kind === "creating" && selection) {
			// A stray click is not a selection: it is how someone clears the one they had.
			if (selection.width < MIN_SELECTION || selection.height < MIN_SELECTION) {
				setSelection(null);
			} else {
				setIsAnnotating(true);
			}
		}
		setDragMode({ kind: "none" });
	};

	if (!initData) {
		return <div className="fixed inset-0 bg-transparent" />;
	}

	const { bounds } = initData;
	// Snapshot pixels → screen pixels, which is the scale the annotator's hit tolerances are in.
	const zoom = annotator.width > 0 ? bounds.width / annotator.width : 1;
	/*
	 * Placed against the bar's real width, not a guess at it.
	 *
	 * `toolbarPosition` keeps the bar on screen by clamping against the width it is told, so a
	 * constant that has drifted from the truth clamps to the wrong place — the bar was 742pt wide
	 * and declared 660, which put its last 82pt, the 完成 button among them, off the right edge of
	 * the screen with no way to reach it. Measured after the first paint and remembered, so this
	 * cannot drift again as controls are added.
	 */
	const toolbarAt = selection ? toolbarPosition(selection, bounds, { ...TOOLBAR_SIZE, ...toolbarSize }) : null;

	return (
		<div
			className="fixed inset-0 select-none overflow-hidden"
			style={{ cursor }}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
		>
			{/*
			 * The frozen screen, shown instantly and deliberately not faded.
			 *
			 * It is a picture of what is already there, so there is nothing to fade *from* — it is
			 * everything drawn on top of it that arrives.
			 */}
			<canvas ref={bgCanvasRef} className="absolute inset-0 block h-full w-full pointer-events-none" />

			{/*
			 * `pointer-events-none`, and everything inside it that is meant to be touched says so
			 * itself. A full-screen layer that swallowed presses would put itself between the user
			 * and the overlay's own handlers — the selection is dragged on the root, not here.
			 */}
			<div
				className="pointer-events-none absolute inset-0"
				style={{
					opacity: leaving || !entered ? 0 : 1,
					transition: `opacity ${leaving ? LEAVE_MS : ENTER_MS}ms ease-out`,
				}}
			>
			{/* Dim mask around selection */}
			{selection && (
				<svg className="pointer-events-none absolute inset-0 h-full w-full">
					<defs>
						<mask id="cutout">
							<rect width="100%" height="100%" fill="white" />
							<rect
								x={selection.x}
								y={selection.y}
								width={selection.width}
								height={selection.height}
								fill="black"
							/>
						</mask>
					</defs>
					<rect width="100%" height="100%" fill="rgba(0, 0, 0, 0.42)" mask="url(#cutout)" />
				</svg>
			)}

			{!selection && (
				<div className="pointer-events-none absolute inset-0 bg-black/25 flex items-center justify-center">
					<div className="rounded-xl border border-white/20 bg-black/60 px-4 py-2 text-label text-white shadow-2xl backdrop-blur-md">
						拖拽鼠标框选截图区域 · 按 Esc 退出
					</div>
				</div>
			)}

			{/*
			 * The annotator, seen through the selection.
			 *
			 * The outer frame is the region and clips to it; the inner one carries the full-screen
			 * canvas back up and left by the region's offset, so the part showing through is exactly
			 * the part that will be saved. Clipping also takes the canvas out of hit testing outside
			 * the frame, which is what leaves a press out there free to start a new selection.
			 */}
			{isAnnotating && selection && (
				<div
					className="pointer-events-auto absolute overflow-hidden"
					style={{
						left: selection.x,
						top: selection.y,
						width: selection.width,
						height: selection.height,
					}}
				>
					<div className="absolute" style={{ left: -selection.x, top: -selection.y }}>
						<AnnotateCanvas
							annotator={annotator}
							zoom={zoom}
							className="bg-transparent"
							style={{ width: bounds.width, height: bounds.height }}
						/>
					</div>
				</div>
			)}

			{/* Selected region borders & resize handles */}
			{selection && (
				<div
					className="pointer-events-none absolute border border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.3)]"
					style={{
						left: selection.x,
						top: selection.y,
						width: selection.width,
						height: selection.height,
					}}
				>
					{HANDLES.map((h) => {
						const pt = handlePoint({ x: 0, y: 0, width: selection.width, height: selection.height }, h);
						return (
							<div
								key={h}
								className="pointer-events-auto absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/30 bg-white shadow-sm"
								style={{ left: pt.x, top: pt.y, cursor: HANDLE_CURSOR[h] }}
							/>
						);
					})}
				</div>
			)}

			{/*
			 * Marked as a control, and belt-and-braces about it.
			 *
			 * `data-screenshot-ui` is what `handlePointerDown` looks for; stopping the press here as
			 * well means it never reaches the overlay's handlers at all, so no rule added there
			 * later can start reading the toolbar as part of the screen either.
			 *
			 * Only the press, never the move or the release. Stopping all three looks tidier and
			 * breaks dragging: the bar sits directly below the selection, so resizing by the
			 * bottom-right handle ends with the pointer over it — and a `pointerup` swallowed there
			 * never reaches the overlay, which is left believing the drag is still going.
			 */}
			{isAnnotating && toolbarAt && (
				<div
					ref={measureToolbar}
					data-screenshot-ui
					className="pointer-events-auto absolute z-[120]"
					style={{ left: toolbarAt.x, top: toolbarAt.y }}
					onPointerDown={(e) => e.stopPropagation()}
				>
					<AnnotateToolbar
						annotator={annotator}
						onCancel={handleCancel}
						onSave={handleFinish}
						canReplace={false}
						saveLabel="完成"
						cancelLabel="取消"
						requireDirty={false}
						className="pointer-events-auto flex items-center gap-1 rounded-2xl border border-white/12 bg-[#1c1c1e]/92 px-2 py-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.45)] backdrop-blur-xl transition-[opacity,transform] duration-[var(--ly-t-base)] ease-out"
					/>
				</div>
			)}
			</div>
		</div>
	);
}
