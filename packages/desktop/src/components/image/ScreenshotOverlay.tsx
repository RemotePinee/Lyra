/**
 * Transparent snipping overlay: selection controls and annotation UI over the live desktop.
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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ScreenshotSettings } from "@lyra/core";
import {
	AnnotateCanvas,
	AnnotateToolbar,
	useAnnotator,
} from "./Annotator.tsx";
import { ScreenshotLoupe, type LoupeReading } from "./ScreenshotLoupe.tsx";
import {
	clampRect,
	findSnapWindow,
	finishCaptureGesture,
	handlePoint,
	hitHandle,
	insideRect,
	isDragFrom,
	moveRect,
	rectFromPoints,
	resizeRect,
	snapshotCssZoom,
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
/**
 * How wide the band around the selection's edge is that picks the whole region up.
 *
 * While annotating, the inside of the selection belongs to the pen: a press there draws. The
 * region still has to be movable, so the grab is the border itself — the same place the eye
 * already reads as the edge of the shot, and the same convention every other capture tool uses.
 */
const EDGE_GRAB = 8;
interface ScreenshotInit {
	session: number;
	snapshot: { pixels: Uint8Array; width: number; height: number } | null;
	bounds: { x: number; y: number; width: number; height: number };
	scaleFactor: number;
	settings?: ScreenshotSettings;
	windows?: SnappableWindow[];
	renderMode?: "live" | "snapshot";
	cursor?: Point;
}

type DragMode =
	| { kind: "none" }
	| { kind: "pending"; from: Point; snap: SnappableWindow | null }
	| { kind: "creating"; from: Point; snap: SnappableWindow | null }
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

function sampleLoupeReading(source: HTMLCanvasElement | null, pt: Point | null, boundsWidth: number): LoupeReading | null {
	if (!source || !pt || !boundsWidth) return null;
	const pixelScale = source.width / boundsWidth;
	const x = Math.round(pt.x * pixelScale);
	const y = Math.round(pt.y * pixelScale);
	if (x < 0 || y < 0 || x >= source.width || y >= source.height) return null;
	const ctx = source.getContext("2d", { willReadFrequently: true });
	const sample = ctx?.getImageData(x, y, 1, 1).data;
	if (!sample) return null;
	const hex = `#${[sample[0], sample[1], sample[2]].map((v) => v!.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
	return { x, y, hex };
}

export function ScreenshotOverlay() {
	const [initData, setInitData] = useState<ScreenshotInit | null>(null);
	const [selection, setSelection] = useState<Rect | null>(null);
	const [hoveredWindow, setHoveredWindow] = useState<SnappableWindow | null>(null);
	const [dragMode, setDragMode] = useState<DragMode>({ kind: "none" });
	const [cursor, setCursor] = useState("default");
	const [isAnnotating, setIsAnnotating] = useState(false);
	const [pointer, setPointer] = useState<Point | null>(null);
	const [reading, setReading] = useState<LoupeReading | null>(null);
	const [copied, setCopied] = useState(false);

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

	const initRef = useRef<ScreenshotInit | null>(null);
	const leavingRef = useRef(false);
	const finishPendingRef = useRef(false);
	const selectionRef = useRef<Rect | null>(null);
	selectionRef.current = selection;
	const pointerRef = useRef<Point | null>(null);
	pointerRef.current = pointer;
	const loupeSourceRef = useRef<HTMLCanvasElement | null>(null);
	const displayBounds = initData?.bounds ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
	const scale = initData?.scaleFactor || window.devicePixelRatio || 1;
	const bitmapWidth = Math.round(displayBounds.width * scale);
	const annotator = useAnnotator(initData?.snapshot ?? null, { session: initData?.session });

	useLayoutEffect(() => {
		const decoded = annotator.image.current;
		const canvas = loupeSourceRef.current;
		if (!decoded || !canvas || !annotator.ready) return;
		if (canvas.width !== decoded.width || canvas.height !== decoded.height) {
			canvas.width = decoded.width;
			canvas.height = decoded.height;
		}
		const ctx = canvas.getContext("2d");
		if (ctx) {
			ctx.imageSmoothingEnabled = false;
			ctx.drawImage(decoded.source, 0, 0);
		}

		// Synchronously take initial reading under pointer before notifying paint
		const cur = pointerRef.current;
		if (!selectionRef.current && cur) {
			const initialSample = sampleLoupeReading(canvas, cur, initRef.current?.bounds.width ?? window.innerWidth);
			if (initialSample) setReading(initialSample);
		}

		// For macOS and Windows snapshot presentation: notify main process first paint is composited
		window.lyra?.screenshot?.painted?.();
	}, [annotator.image, annotator.ready, annotator.width]);

	useEffect(() => {
		if (selection || !pointer) {
			setReading(null);
			return;
		}
		const sample = sampleLoupeReading(loupeSourceRef.current, pointer, initRef.current?.bounds.width ?? window.innerWidth);
		if (sample) setReading(sample);
	}, [annotator.ready, pointer, selection]);

	useEffect(() => {
		const cleanupInit = window.lyra?.screenshot?.onInit((data: ScreenshotInit) => {
			const prev = initRef.current;
			const sameSession = prev?.session === data.session;
			const next: ScreenshotInit = {
				session: data.session,
				bounds: data.bounds ?? prev?.bounds ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
				scaleFactor: data.scaleFactor ?? prev?.scaleFactor ?? 1,
				settings: data.settings ?? prev?.settings,
				// IPC clones Uint8Array payloads. Keep the first snapshot for later window updates, or
				// the persistent overlay would decode the same screen and erase its marks repeatedly.
				snapshot: data.snapshot === null
					? null
					: data.snapshot !== undefined && (!sameSession || !prev?.snapshot)
						? data.snapshot
						: prev?.snapshot ?? null,
				windows: data.windows ?? prev?.windows,
				renderMode: data.renderMode ?? prev?.renderMode,
				cursor: data.cursor ?? prev?.cursor,
			};
			initRef.current = next;
			setInitData(next);

			if (!sameSession) {
				leavingRef.current = false;
				finishPendingRef.current = false;
				setSelection(null);
				setDragMode({ kind: "none" });
				setIsAnnotating(false);
				setCopied(false);
				setReading(null);
				setCursor("default");
				const cursor = data.cursor ?? null;
				setPointer(cursor);
				setHoveredWindow(
					cursor && next.windows?.length
						? findSnapWindow(next.windows, cursor, next.bounds)
						: null,
				);
			} else if (!prev?.windows?.length && next.windows?.length && !selectionRef.current) {
				const cur = pointerRef.current ?? data.cursor ?? null;
				if (cur) {
					setHoveredWindow(findSnapWindow(next.windows, cur, next.bounds));
				}
			}
		});

		const cleanupReset = window.lyra?.screenshot?.onReset?.(() => {
			leavingRef.current = true;
			initRef.current = null;
			setInitData(null);
			setSelection(null);
			setHoveredWindow(null);
			setReading(null);
			setPointer(null);
			setIsAnnotating(false);
			setDragMode({ kind: "none" });
			setCursor("default");
			setCopied(false);
			const canvas = loupeSourceRef.current;
			if (canvas) {
				const ctx = canvas.getContext("2d");
				ctx?.clearRect(0, 0, canvas.width, canvas.height);
				canvas.width = 0;
				canvas.height = 0;
			}
		});

		window.lyra?.screenshot?.ready?.();
		return () => {
			cleanupInit?.();
			cleanupReset?.();
		};
	}, []);

	const snapWindows = initData?.windows;
	const snapBounds = initData?.bounds;
	useEffect(() => {
		if (selection || dragMode.kind !== "none") return;
		if (!snapWindows?.length || !pointer || !snapBounds) return;
		const matched = findSnapWindow(snapWindows, pointer, snapBounds);
		setHoveredWindow((prev) => (prev?.id === matched?.id ? prev : matched));
	}, [snapWindows, snapBounds, pointer, selection, dragMode.kind]);

	/**
	 * Guard teardown without delaying it.
	 *
	 * This window is always on top and owns the pointer while visible. Waiting for a renderer timer
	 * before asking the main process to destroy it can leave the whole desktop trapped if that timer
	 * or IPC path stalls; the main process owns the window, so teardown is requested immediately.
	 */
	const beginLeaving = useCallback(() => {
		if (leavingRef.current) return false;
		leavingRef.current = true;
		return true;
	}, []);

	// Releasing the always-on-top input window cannot depend on an animation timer.
	const handleCancel = useCallback(() => {
		if (!beginLeaving()) return;
		setSelection(null);
		setHoveredWindow(null);
		setReading(null);
		setPointer(null);
		setIsAnnotating(false);
		setDragMode({ kind: "none" });
		const canvas = loupeSourceRef.current;
		if (canvas) {
			const ctx = canvas.getContext("2d");
			ctx?.clearRect(0, 0, canvas.width, canvas.height);
			canvas.width = 0;
			canvas.height = 0;
		}
		void window.lyra.screenshot.cancel();
	}, [beginLeaving]);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				handleCancel();
				return;
			}
			if ((e.metaKey || e.ctrlKey || e.key.toLowerCase() === "c") && reading && !selection) {
				e.preventDefault();
				void window.lyra.screenshot.copyColor(reading.hex);
				setCopied(true);
			}
		};
		const handleBlur = () => {
			setCopied(false);
		};
		window.addEventListener("keydown", handleKeyDown);
		window.addEventListener("blur", handleBlur);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("blur", handleBlur);
		};
	}, [handleCancel, reading, selection]);

	/** Cut the selection from the upstream annotator's full-resolution composited canvas. */
	const handleFinish = useCallback(() => {
		const source = annotator.canvas.current;
		const latest = initRef.current;
		if (!selection || !latest) return;
		if (!annotator.ready || !source || (source.width === 300 && source.height === 150)) {
			finishPendingRef.current = true;
			return;
		}
		finishPendingRef.current = false;

		const outScale = source.width / latest.bounds.width;
		const out = document.createElement("canvas");
		out.width = Math.max(1, Math.round(selection.width * outScale));
		out.height = Math.max(1, Math.round(selection.height * outScale));
		const ctx = out.getContext("2d");
		if (!ctx) return;

		const sx = Math.round(selection.x * outScale);
		const sy = Math.round(selection.y * outScale);

		// First, render the crystal-clear baseline desktop capture
		const bgSource = annotator.image.current?.source ?? loupeSourceRef.current;
		if (bgSource) {
			ctx.drawImage(bgSource, sx, sy, out.width, out.height, 0, 0, out.width, out.height);
		}

		// Second, blend on top the transparent annotation marks (drawings, arrows, text)
		ctx.drawImage(source, sx, sy, out.width, out.height, 0, 0, out.width, out.height);

		if (!beginLeaving()) return;
		const outDataUrl = out.toDataURL("image/png");
		const outSettings = latest.settings;
		setSelection(null);
		setHoveredWindow(null);
		setReading(null);
		setPointer(null);
		setIsAnnotating(false);
		setDragMode({ kind: "none" });
		void window.lyra.screenshot.finish(outDataUrl, outSettings);
	}, [annotator, selection, beginLeaving]);

	useEffect(() => {
		if (annotator.ready && finishPendingRef.current) handleFinish();
	}, [annotator.ready, handleFinish]);

	const handlePointerDown = (e: React.PointerEvent) => {
		if ((e.target as HTMLElement).closest?.("[data-screenshot-ui]")) return;
		if (e.button === 2 && reading && !selection) {
			e.preventDefault();
			e.stopPropagation();
			void window.lyra.screenshot.copyColor(reading.hex);
			setCopied(true);
			return;
		}
		const pt: Point = { x: e.clientX, y: e.clientY };
		const take = () => {
			e.stopPropagation();
			(e.target as HTMLElement).setPointerCapture?.(e.pointerId);
		};

		if (selection) {
			const handle = hitHandle(selection, pt, HANDLE_GRAB);
			if (handle) {
				setDragMode({ kind: "resizing", handle, origin: selection });
				take();
				return;
			}
			if (insideRect(selection, pt)) {
				if (!isAnnotating || onEdge(selection, pt, EDGE_GRAB)) {
					setDragMode({ kind: "moving", from: pt, origin: selection });
					take();
				}
				return;
			}
			// Once a region exists, presses outside it cannot discard the crop and its marks.
			return;
		}

		setIsAnnotating(false);
		setDragMode({ kind: "pending", from: pt, snap: hoveredWindow });
		take();
	};

	const handlePointerMove = (e: React.PointerEvent) => {
		const pt: Point = { x: e.clientX, y: e.clientY };
		if (!selection) {
			setPointer(pt);
			const sample = sampleLoupeReading(loupeSourceRef.current, pt, initData?.bounds.width ?? window.innerWidth);
			if (sample) setReading(sample);
		}
		const bounds = initData?.bounds ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };

		if (dragMode.kind === "pending") {
			if (!isDragFrom(dragMode.from, pt)) return;
			setDragMode({ kind: "creating", from: dragMode.from, snap: dragMode.snap });
			setHoveredWindow(null);
			setSelection(clampRect(rectFromPoints(dragMode.from, pt), bounds));
		} else if (dragMode.kind === "creating") {
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
			setCursor("default");
		} else {
			setCursor("default");
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

		if (dragMode.kind === "pending" || dragMode.kind === "creating") {
			const next = initData
				? finishCaptureGesture(
					dragMode.kind === "pending"
						? { kind: "pending", snap: dragMode.snap }
						: { kind: "creating", snap: dragMode.snap, draft: selection },
					initData.bounds,
				)
				: null;
			setSelection(next);
			if (next) {
				setIsAnnotating(true);
				setHoveredWindow(null);
				setCursor("default");
			}
		}
		setDragMode({ kind: "none" });
	};

	const bounds = displayBounds;
	const physicalWidth = annotator.width || bitmapWidth;
	const physicalHeight = annotator.image.current?.height || Math.round(bounds.height * scale);
	// 1:1 pixel mapping: width in CSS DIP that exactly matches physical bitmap resolution when scaled by DPR
	const canvasWidth = annotator.width > 0 && scale > 0 ? annotator.width / scale : bounds.width;
	const canvasHeight = physicalHeight > 0 && scale > 0 ? physicalHeight / scale : bounds.height;
	const zoom = snapshotCssZoom(physicalWidth, bounds.width, scale);
	const hoverRect =
		!selection && hoveredWindow && initData ? windowToLocalRect(hoveredWindow, initData.bounds) : null;
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

	if (!initData) return null;

	return (
		<div
			data-screenshot-overlay
			className="fixed inset-0 select-none overflow-hidden bg-transparent"
			style={{ cursor }}
			onPointerDownCapture={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			onContextMenu={(e) => e.preventDefault()}
		>
			<canvas
				ref={loupeSourceRef}
				className="pointer-events-none absolute left-0 top-0 block"
				style={{
					width: canvasWidth,
					height: canvasHeight,
					opacity: annotator.ready ? 1 : 0,
					imageRendering: "-webkit-optimize-contrast",
				}}
				aria-hidden="true"
			/>
			{/* Semi-transparent backdrop with punch-hole cutout for selection or hovered window */}
			<svg className="pointer-events-none absolute inset-0 h-full w-full">
				<defs>
					<mask id="screenshot-punch-mask">
						<rect width="100%" height="100%" fill="white" />
						{(selection || hoverRect) && (
							<rect
								x={(selection ?? hoverRect)!.x}
								y={(selection ?? hoverRect)!.y}
								width={(selection ?? hoverRect)!.width}
								height={(selection ?? hoverRect)!.height}
								fill="black"
							/>
						)}
					</mask>
				</defs>
				<rect
					width="100%"
					height="100%"
					fill="rgba(0, 0, 0, 0.32)"
					mask="url(#screenshot-punch-mask)"
				/>
			</svg>
			{/*
			 * `pointer-events-none`, and everything inside it that is meant to be touched says so
			 * itself. A full-screen layer that swallowed presses would put itself between the user
			 * and the overlay's own handlers — the selection is dragged on the root, not here.
			 */}
			<div className="pointer-events-none absolute inset-0">
			{hoverRect && hoveredWindow && (
				<div
					data-snap-hover
					className="pointer-events-none absolute border-sky-400"
					style={{
						left: hoverRect.x,
						top: hoverRect.y,
						width: hoverRect.width,
						height: hoverRect.height,
						boxShadow: "0 0 0 2px rgb(56 189 248)",
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
			 * The annotator, clipped strictly to the selection boundary via clip-path.
			 *
			 * Anchored at the exact full-screen origin (0, 0) matching the backdrop canvas below.
			 * Using GPU-accelerated clip-path instead of double-nested offset divs prevents
			 * subpixel rasterization misalignment, eliminating any visual shifting or jumping
			 * inside the selection rectangle upon snapping or cropping.
			 */}
			{isAnnotating && selection && annotator.ready && (
				<div
					className="pointer-events-auto absolute left-0 top-0"
					style={{
						width: canvasWidth,
						height: canvasHeight,
						clipPath: `inset(${selection.y}px ${Math.max(0, canvasWidth - selection.x - selection.width)}px ${Math.max(0, canvasHeight - selection.y - selection.height)}px ${selection.x}px)`,
					}}
				>
					<AnnotateCanvas
						annotator={annotator}
						zoom={zoom}
						className="bg-transparent"
						transparentBackground={true}
						style={{
							width: canvasWidth,
							height: canvasHeight,
							cursor: annotator.tool === "pen" ? "default" : undefined,
							imageRendering: "-webkit-optimize-contrast",
						}}
					/>
				</div>
			)}

			{/* Selected region borders & resize handles */}
			{selection && (
				<div
					className="pointer-events-none absolute border-white/90"
					style={{
						left: selection.x,
						top: selection.y,
						width: selection.width,
						height: selection.height,
						boxShadow: "0 0 0 2px rgba(255,255,255,0.9), 0 0 0 3px rgba(0,0,0,0.35)",
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
			{!selection && pointer && annotator.ready && (
				<ScreenshotLoupe
					source={loupeSourceRef.current}
					at={pointer}
					scale={annotator.width && bounds.width ? annotator.width / bounds.width : scale}
					viewport={bounds}
					reading={reading}
					copied={copied}
				/>
			)}

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
