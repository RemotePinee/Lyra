/**
 * Fullscreen snipping overlay: captured desktop, dim mask and cutout.
 *
 * Two coordinate spaces meet here. The selection and every pointer event are in CSS pixels, because
 * that is what the overlay window is measured in. Marks live in the snapshot's own pixels, which
 * on a Retina screen are twice as many. `AnnotateCanvas` is given an explicit CSS size — the display
 * it is standing on, at 1:1 — rather than laying out at its bitmap's size.
 *
 * The window never paints the captured desktop as a backdrop: entering capture mode changes only the
 * cursor and interaction UI, while the snapshot remains an off-screen source for export and mosaic.
 * The selected region is a window onto the full-size canvas, shifted by the selection's offset, so
 * marks stay put when the frame is moved afterwards.
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
	findSnapWindow,
	handlePoint,
	hitHandle,
	insideRect,
	moveRect,
	rectFromPoints,
	resizeRect,
	toolbarPosition,
	windowToLocalRect,
	HANDLES,
	HANDLE_CURSOR,
	type Handle,
	type Point,
	type Rect,
	type SnappableWindow,
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
	windows?: SnappableWindow[];
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
	const [hoveredWindow, setHoveredWindow] = useState<SnappableWindow | null>(null);
	const [dragMode, setDragMode] = useState<DragMode>({ kind: "none" });
	const [cursor, setCursor] = useState("crosshair");
	const [isAnnotating, setIsAnnotating] = useState(false);

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

	const snapshotWaiters = useRef<Array<(src: string) => void>>([]);
	const initRef = useRef<ScreenshotInit | null>(null);
	const displayBounds = initData?.bounds ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
	const scale = initData?.scaleFactor || window.devicePixelRatio || 1;
	const bitmapWidth = Math.round(displayBounds.width * scale);
	const bitmapHeight = Math.round(displayBounds.height * scale);
	const annotator = useAnnotator(initData?.snapshot ?? "", { bitmapWidth });

	useEffect(() => {
		const cleanup = window.lyra?.screenshot?.onInit((data: ScreenshotInit) => {
			setInitData((prev) => {
				const next: ScreenshotInit = {
					bounds: data.bounds ?? prev?.bounds ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
					scaleFactor: data.scaleFactor ?? prev?.scaleFactor ?? 1,
					settings: data.settings ?? prev?.settings,
					snapshot: data.snapshot || prev?.snapshot || "",
					windows: data.windows ?? prev?.windows,
				};
				initRef.current = next;
				return next;
			});
			if (data.snapshot) {
				for (const wait of snapshotWaiters.current.splice(0)) wait(data.snapshot);
			}
		});
		window.lyra?.screenshot?.ready?.();
		return cleanup;
	}, []);

	/**
	 * Guard teardown without delaying it.
	 *
	 * This window is always on top and owns the pointer while visible. Waiting for a renderer timer
	 * before asking the main process to destroy it can leave the whole desktop trapped if that timer
	 * or IPC path stalls; the main process owns the window, so teardown is requested immediately.
	 */
	const leavingRef = useRef(false);
	const beginLeaving = useCallback(() => {
		if (leavingRef.current) return false;
		leavingRef.current = true;
		return true;
	}, []);

	// Releasing the always-on-top input window cannot depend on an animation timer.
	const handleCancel = useCallback(() => {
		if (!beginLeaving()) return;
		void window.lyra.screenshot.cancel();
	}, [beginLeaving]);

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

	const waitForSnapshot = useCallback((): Promise<string> => {
		const have = initRef.current?.snapshot;
		if (have) return Promise.resolve(have);
		return new Promise((resolve) => {
			snapshotWaiters.current.push(resolve);
			setTimeout(() => resolve(initRef.current?.snapshot || ""), 4000);
		});
	}, []);

	/**
	 * Cut the selection and its marks out at the snapshot's own resolution. The snapshot stays
	 * off-screen throughout capture; this is the only point where it is composed for user output.
	 */
	const handleFinish = useCallback(async () => {
		if (!selection) return;

		const snapshotSrc = await waitForSnapshot();
		if (!snapshotSrc) return;
		const latest = initRef.current;
		const bounds = latest?.bounds ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
		const markCanvas = annotator.canvas.current;
		let snapshotImg = annotator.image.current;

		if (!snapshotImg || snapshotImg.src !== snapshotSrc || !snapshotImg.complete || snapshotImg.naturalWidth === 0) {
			snapshotImg = new Image();
			snapshotImg.src = snapshotSrc;
			try {
				await snapshotImg.decode();
			} catch {
				return;
			}
		}

		const naturalW = snapshotImg.naturalWidth || markCanvas?.width || bounds.width * (latest?.scaleFactor || 1);
		const outScale = bounds.width > 0 ? naturalW / bounds.width : 1;

		const outW = Math.max(1, Math.round(selection.width * outScale));
		const outH = Math.max(1, Math.round(selection.height * outScale));
		const sx = Math.round(selection.x * outScale);
		const sy = Math.round(selection.y * outScale);

		const out = document.createElement("canvas");
		out.width = outW;
		out.height = outH;
		const ctx = out.getContext("2d", { willReadFrequently: true });
		if (!ctx) return;

		ctx.drawImage(snapshotImg, sx, sy, outW, outH, 0, 0, outW, outH);
		if (markCanvas && markCanvas.width > 0 && markCanvas.height > 0) {
			ctx.drawImage(markCanvas, sx, sy, outW, outH, 0, 0, outW, outH);
		}

		const png = out.toDataURL("image/png");
		if (!beginLeaving()) return;
		void window.lyra.screenshot.finish(png, latest?.settings);
	}, [annotator, selection, beginLeaving, waitForSnapshot]);

	const handlePointerDown = (e: React.PointerEvent) => {
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
				// When annotating, the inside belongs to AnnotateCanvas for drawing marks
				if (!isAnnotating || onEdge(selection, pt, EDGE_GRAB)) {
					setDragMode({ kind: "moving", from: pt, origin: selection });
					(e.target as HTMLElement).setPointerCapture(e.pointerId);
				}
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
		const pt: Point = { x: e.clientX, y: e.clientY };
		const bounds = initData?.bounds ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };

		if (dragMode.kind === "creating") {
			const rect = clampRect(rectFromPoints(dragMode.from, pt), bounds);
			setSelection(rect);
		} else if (dragMode.kind === "moving") {
			const dx = pt.x - dragMode.from.x;
			const dy = pt.y - dragMode.from.y;
			const rect = moveRect(dragMode.origin, dx, dy, bounds);
			setSelection(rect);
		} else if (dragMode.kind === "resizing") {
			const rect = clampRect(
				resizeRect(dragMode.origin, dragMode.handle, pt),
				bounds,
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
				// The canvas owns tool-specific cursors; the frame only claims its movable edge.
				setCursor(onEdge(selection, pt, EDGE_GRAB) ? "move" : "default");
				return;
			}
			setCursor("crosshair");
		} else {
			setCursor("crosshair");
			// When there is no active selection, smart-detect hovered window for snapping
			if (initData?.windows && initData.windows.length > 0) {
				const matched = findSnapWindow(initData.windows, pt, bounds);
				setHoveredWindow(matched);
			}
		}
	};

	const handlePointerUp = (e: React.PointerEvent) => {
		try {
			if ((e.target as HTMLElement).hasPointerCapture?.(e.pointerId)) {
				(e.target as HTMLElement).releasePointerCapture(e.pointerId);
			}
		} catch {
			// Ignore DOMException if capture was already released
		}

		if (dragMode.kind === "creating" && selection) {
			// A single click without dragging: if we were hovering a window, snap directly to that window
			if (selection.width < MIN_SELECTION || selection.height < MIN_SELECTION) {
				if (hoveredWindow && initData) {
					const snapped = windowToLocalRect(hoveredWindow, initData.bounds);
					setSelection(snapped);
					setIsAnnotating(true);
					setHoveredWindow(null);
					setCursor("default");
				} else {
					setSelection(null);
				}
			} else {
				setIsAnnotating(true);
				setHoveredWindow(null);
				setCursor("default");
			}
		}
		setDragMode({ kind: "none" });
	};

	const bounds = displayBounds;
	const physicalWidth = annotator.width || bitmapWidth;
	// Snapshot pixels → screen pixels, which is the scale the annotator's hit tolerances are in.
	const zoom = physicalWidth > 0 ? bounds.width / physicalWidth : 1;
	const hoverRect =
		!selection && hoveredWindow && initData ? windowToLocalRect(hoveredWindow, initData.bounds) : null;
	const hole = selection ?? hoverRect;
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
			data-screenshot-overlay
			className="fixed inset-0 select-none overflow-hidden bg-transparent"
			style={{ cursor }}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
		>
			{/*
			 * `pointer-events-none`, and everything inside it that is meant to be touched says so
			 * itself. A full-screen layer that swallowed presses would put itself between the user
			 * and the overlay's own handlers — the selection is dragged on the root, not here.
			 */}
			<div className="pointer-events-none absolute inset-0">
			{/* Dim mask around selection */}
			{hole && (
				<svg className="pointer-events-none absolute inset-0 h-full w-full">
					<defs>
						<mask id="cutout">
							<rect width="100%" height="100%" fill="white" />
							<rect x={hole.x} y={hole.y} width={hole.width} height={hole.height} fill="black" />
						</mask>
					</defs>
					<rect width="100%" height="100%" fill="rgba(0, 0, 0, 0.42)" mask="url(#cutout)" />
				</svg>
			)}

			{hoverRect && hoveredWindow && (
				<div
					className="pointer-events-none absolute border-2 border-sky-400"
					style={{
						left: hoverRect.x,
						top: hoverRect.y,
						width: hoverRect.width,
						height: hoverRect.height,
					}}
				>
					<div
						className="absolute left-0 flex items-center gap-1.5 rounded-md bg-sky-500 px-2 py-0.5 text-detail font-medium text-white shadow-md"
						style={{
							top: hoverRect.y < 32 ? 4 : -28,
						}}
					>
						<span className="max-w-[320px] truncate">{hoveredWindow.title || "窗口"}</span>
						<span className="opacity-75">{hoveredWindow.width} × {hoveredWindow.height}</span>
					</div>
				</div>
			)}
			</div>

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
							paintBackdrop={false}
							pixelSize={{ width: bitmapWidth, height: bitmapHeight }}
							className="bg-transparent"
							style={{
								width: bounds.width,
								height: bounds.height,
								cursor: annotator.tool === "pen" ? "default" : undefined,
							}}
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
	);
}
