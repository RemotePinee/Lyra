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

	// Cancel / close screenshot
	const handleCancel = useCallback(() => {
		window.lyra?.screenshot?.cancel?.();
	}, []);

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

		window.lyra?.screenshot?.finish?.(out.toDataURL("image/png"), initData.settings);
	}, [annotator, selection, initData]);

	// Selection pointer events
	const handlePointerDown = (e: React.PointerEvent) => {
		if (!initData) return;
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
	const toolbarAt = selection ? toolbarPosition(selection, bounds, TOOLBAR_SIZE) : null;

	return (
		<div
			className="fixed inset-0 select-none overflow-hidden"
			style={{ cursor }}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
		>
			{/* Frozen snapshot canvas */}
			<canvas ref={bgCanvasRef} className="absolute inset-0 block h-full w-full pointer-events-none" />

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
					className="absolute overflow-hidden"
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

			{isAnnotating && toolbarAt && (
				<AnnotateToolbar
					annotator={annotator}
					onCancel={handleCancel}
					onSave={handleFinish}
					canReplace={false}
					saveLabel="完成"
					cancelLabel="取消"
					requireDirty={false}
					className="pointer-events-auto absolute z-[120] flex items-center gap-1 rounded-2xl border border-white/12 bg-[#1c1c1e]/92 px-2 py-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.45)] backdrop-blur-xl transition-[opacity,transform] duration-[var(--ly-t-base)] ease-out"
					style={{ left: toolbarAt.x, top: toolbarAt.y }}
				/>
			)}
		</div>
	);
}
