/**
 * Fullscreen in-place screenshot overlay & annotator.
 *
 * Rendered when window.location.hash is '#/screenshot-overlay'.
 * Shows the frozen screen snapshot, provides crosshair drag selection,
 * auto-dims outside selection, and attaches the floating annotation toolbar
 * right below the selection box.
 */

import {
	ArrowUpRight,
	Check,
	Circle,
	Grid2x2,
	Pencil,
	Redo2,
	Square,
	Type,
	Undo2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ScreenshotSettings } from "@lyra/core";
import {
	canRedo,
	canUndo,
	current,
	emptyHistory,
	redo,
	undo,
	type History,
	type Point,
	type Shape,
	type Tool,
} from "./annotate.ts";

const COLOURS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#ffffff", "#111827"];
const STROKE_BASE = 3;

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export function ScreenshotOverlay() {
	const [snapshot, setSnapshot] = useState<string | null>(null);
	/** The snapshot has decoded and can be drawn. See where it is set for why this is state. */
	const [imageReady, setImageReady] = useState(false);
	const [scaleFactor, setScaleFactor] = useState(2);
	const [settings, setSettings] = useState<ScreenshotSettings | undefined>(undefined);

	// Selection rectangle in CSS pixels (screen coordinate)
	const [selection, setSelection] = useState<Rect | null>(null);
	const [isSelecting, setIsSelecting] = useState(false);
	const [selectionStart, setSelectionStart] = useState<Point | null>(null);

	// Annotation mode
	const [tool, setTool] = useState<Tool | null>(null);
	const [colour, setColour] = useState(COLOURS[0]!);
	const [history, setHistory] = useState<History>(emptyHistory);

	const bgCanvasRef = useRef<HTMLCanvasElement>(null);
	const markCanvasRef = useRef<HTMLCanvasElement>(null);
	const imageRef = useRef<HTMLImageElement | null>(null);
	const pixelsRef = useRef<HTMLCanvasElement | null>(null);

	// 1. Listen for initialization from main process
	useEffect(() => {
		return window.lyra.screenshot.onInit((data) => {
			setSnapshot(data.snapshot);
			setScaleFactor(data.scaleFactor || 2);
			setSettings(data.settings);

			const img = new Image();
			img.onload = () => {
				imageRef.current = img;

				// Generate low-res pixels canvas for mosaic
				const pxCanvas = document.createElement("canvas");
				const block = Math.max(8, Math.round(img.naturalWidth / 100));
				pxCanvas.width = Math.max(1, Math.floor(img.naturalWidth / block));
				pxCanvas.height = Math.max(1, Math.floor(img.naturalHeight / block));
				const ctx = pxCanvas.getContext("2d", { willReadFrequently: true });
				if (ctx) {
					ctx.imageSmoothingEnabled = true;
					ctx.drawImage(img, 0, 0, pxCanvas.width, pxCanvas.height);
				}
				pixelsRef.current = pxCanvas;
				/*
				 * A ref does not schedule a render, and the effect that paints the snapshot reads
				 * this one. Without saying so in state, the image arrived and nothing drew it: the
				 * background stayed empty until some unrelated state changed — which is to say
				 * until the pointer moved. This makes the paint a consequence of the image landing.
				 */
				setImageReady(true);
			};
			img.src = data.snapshot;
		});
	}, []);

	// Draw Background + Dimmed Mask
	useEffect(() => {
		const canvas = bgCanvasRef.current;
		if (!canvas || !imageRef.current) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const width = window.innerWidth;
		const height = window.innerHeight;
		canvas.width = width * scaleFactor;
		canvas.height = height * scaleFactor;

		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(imageRef.current, 0, 0, canvas.width, canvas.height);

		// Mask layer
		ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
		if (!selection || selection.width === 0 || selection.height === 0) {
			// Dim full screen before selection
			ctx.fillRect(0, 0, canvas.width, canvas.height);
		} else {
			// Dim outside selection
			const sx = selection.x * scaleFactor;
			const sy = selection.y * scaleFactor;
			const sw = selection.width * scaleFactor;
			const sh = selection.height * scaleFactor;

			ctx.beginPath();
			ctx.rect(0, 0, canvas.width, canvas.height);
			ctx.rect(sx, sy, sw, sh);
			ctx.fill("evenodd");
		}

		/*
		 * The window is still hidden until this. See `startScreenshotSession`: showing it when the
		 * document loaded put an empty overlay over the screen for the few frames it took the
		 * snapshot to arrive, decode and reach this canvas — which read as the screen blinking
		 * before it froze. Sent every paint; the main process only acts on the first.
		 */
		window.lyra.screenshot.ready();
	}, [snapshot, imageReady, selection, scaleFactor]);

	// Repaint marks
	useEffect(() => {
		const canvas = markCanvasRef.current;
		if (!canvas || !selection) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		canvas.width = selection.width * scaleFactor;
		canvas.height = selection.height * scaleFactor;
		ctx.clearRect(0, 0, canvas.width, canvas.height);

		const shapes = current(history);
		for (let i = 0; i < shapes.length; i++) {
			const shape = shapes[i];
			if (!shape) continue;
			// Draw shape offset by selection.x / selection.y
			drawShapeOnOverlay(ctx, shape, selection, scaleFactor, pixelsRef.current);
		}
	}, [history, selection, scaleFactor]);

	// Mouse handlers for dragging selection
	const onMouseDown = (e: React.MouseEvent) => {
		if (tool) return; // If tool is selected, we are annotating inside selection
		if (e.button !== 0) return;

		setIsSelecting(true);
		setSelectionStart({ x: e.clientX, y: e.clientY });
		setSelection({ x: e.clientX, y: e.clientY, width: 0, height: 0 });
	};

	const onMouseMove = (e: React.MouseEvent) => {
		if (!isSelecting || !selectionStart) return;

		const currentX = e.clientX;
		const currentY = e.clientY;
		const x = Math.min(selectionStart.x, currentX);
		const y = Math.min(selectionStart.y, currentY);
		const width = Math.abs(currentX - selectionStart.x);
		const height = Math.abs(currentY - selectionStart.y);

		setSelection({ x, y, width, height });
	};

	const onMouseUp = () => {
		if (isSelecting) {
			setIsSelecting(false);
			setSelectionStart(null);
			if (selection && (selection.width < 10 || selection.height < 10)) {
				setSelection(null);
			}
		}
	};

	// Export selected & annotated area to DataURL
	const handleFinish = useCallback(async () => {
		if (!selection || !imageRef.current) return;

		const outCanvas = document.createElement("canvas");
		outCanvas.width = selection.width * scaleFactor;
		outCanvas.height = selection.height * scaleFactor;
		const ctx = outCanvas.getContext("2d");
		if (!ctx) return;

		// 1. Draw raw background region
		const sx = selection.x * scaleFactor;
		const sy = selection.y * scaleFactor;
		const sw = selection.width * scaleFactor;
		const sh = selection.height * scaleFactor;

		ctx.drawImage(imageRef.current, sx, sy, sw, sh, 0, 0, sw, sh);

		// 2. Draw annotations on top
		const shapes = current(history);
		for (const shape of shapes) {
			drawShapeOnOverlay(ctx, shape, selection, scaleFactor, pixelsRef.current);
		}

		const dataUrl = outCanvas.toDataURL("image/png");
		await window.lyra.screenshot.finish(dataUrl, settings);
	}, [selection, scaleFactor, history, settings]);

	// Keyboard shortcuts (ESC to cancel, Enter to finish)
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				void window.lyra.screenshot.cancel();
			} else if (e.key === "Enter" && selection && selection.width > 10 && selection.height > 10) {
				e.preventDefault();
				void handleFinish();
			} else if ((e.metaKey || e.ctrlKey) && e.key === "z") {
				e.preventDefault();
				if (e.shiftKey) {
					setHistory((h) => redo(h));
				} else {
					setHistory((h) => undo(h));
				}
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [selection, history, handleFinish]);

	if (!snapshot) return null;

	return (
		<div
			className="relative h-screen w-screen overflow-hidden select-none cursor-crosshair"
			onMouseDown={onMouseDown}
			onMouseMove={onMouseMove}
			onMouseUp={onMouseUp}
		>
			{/* Background canvas */}
			<canvas
				ref={bgCanvasRef}
				className="absolute inset-0 h-full w-full pointer-events-none"
			/>

			{/* Active Selection Box */}
			{selection && (
				<div
					className="absolute border border-blue-500 shadow-2xl pointer-events-none"
					style={{
						left: selection.x,
						top: selection.y,
						width: selection.width,
						height: selection.height,
					}}
				>
					{/* Size Badge */}
					<div className="absolute -top-7 left-0 rounded bg-black/75 px-2 py-0.5 text-xs text-white tabular-nums">
						{Math.round(selection.width * scaleFactor)} × {Math.round(selection.height * scaleFactor)}
					</div>

					{/* Mark Canvas */}
					<canvas
						ref={markCanvasRef}
						className="absolute inset-0 h-full w-full pointer-events-none"
					/>
				</div>
			)}

			{/* In-place Floating Toolbar */}
			{selection && selection.width > 20 && selection.height > 20 && !isSelecting && (
				<div
					className="pointer-events-auto absolute z-50 flex items-center gap-1 rounded-xl bg-neutral-900/90 p-1.5 shadow-2xl backdrop-blur-md border border-white/15"
					style={{
						left: Math.min(
							window.innerWidth - 380,
							Math.max(16, selection.x + selection.width - 360),
						),
						top:
							selection.y + selection.height + 12 > window.innerHeight - 56
								? Math.max(16, selection.y - 52)
								: selection.y + selection.height + 12,
					}}
					onMouseDown={(e) => e.stopPropagation()}
				>
					{/* Annotation Tool Buttons */}
					<ToolButton
						icon={<Square size={16} />}
						active={tool === "rect"}
						tip="矩形框 (R)"
						onClick={() => setTool(tool === "rect" ? null : "rect")}
					/>
					<ToolButton
						icon={<Circle size={16} />}
						active={tool === "ellipse"}
						tip="椭圆 (O)"
						onClick={() => setTool(tool === "ellipse" ? null : "ellipse")}
					/>
					<ToolButton
						icon={<ArrowUpRight size={16} />}
						active={tool === "arrow"}
						tip="箭头 (A)"
						onClick={() => setTool(tool === "arrow" ? null : "arrow")}
					/>
					<ToolButton
						icon={<Pencil size={16} />}
						active={tool === "pen"}
						tip="画笔 (P)"
						onClick={() => setTool(tool === "pen" ? null : "pen")}
					/>
					<ToolButton
						icon={<Grid2x2 size={16} />}
						active={tool === "mosaic"}
						tip="马赛克 (M)"
						onClick={() => setTool(tool === "mosaic" ? null : "mosaic")}
					/>
					<ToolButton
						icon={<Type size={16} />}
						active={tool === "text"}
						tip="文字 (T)"
						onClick={() => setTool(tool === "text" ? null : "text")}
					/>

					<div className="mx-1 h-4 w-px bg-white/20" />

					{/* Colors */}
					<div className="flex items-center gap-1">
						{COLOURS.map((c) => (
							<button
								key={c}
								type="button"
								onClick={() => setColour(c)}
								className={`h-4 w-4 rounded-full border border-black/40 transition-transform ${
									colour === c ? "scale-125 ring-2 ring-white" : "hover:scale-110"
								}`}
								style={{ backgroundColor: c }}
							/>
						))}
					</div>

					<div className="mx-1 h-4 w-px bg-white/20" />

					{/* Undo / Redo */}
					<ToolButton
						icon={<Undo2 size={16} />}
						disabled={!canUndo(history)}
						tip="撤销 (⌘Z)"
						onClick={() => setHistory((h) => undo(h))}
					/>
					<ToolButton
						icon={<Redo2 size={16} />}
						disabled={!canRedo(history)}
						tip="重做 (⇧⌘Z)"
						onClick={() => setHistory((h) => redo(h))}
					/>

					<div className="mx-1 h-4 w-px bg-white/20" />

					{/* Cancel / Finish */}
					<ToolButton
						icon={<X size={16} />}
						tip="取消 (ESC)"
						onClick={() => void window.lyra.screenshot.cancel()}
					/>
					<button
						type="button"
						onClick={() => void handleFinish()}
						className="flex items-center gap-1 rounded-lg bg-blue-500 hover:bg-blue-600 px-3 py-1 text-xs font-semibold text-white shadow transition-colors"
					>
						<Check size={14} strokeWidth={2.5} />
						完成
					</button>
				</div>
			)}
		</div>
	);
}

function ToolButton({
	icon,
	active,
	disabled,
	tip,
	onClick,
}: {
	icon: React.ReactNode;
	active?: boolean;
	disabled?: boolean;
	tip: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			data-ly-tip={tip}
			className={`flex h-7 w-7 items-center justify-center rounded-lg text-white/80 transition-colors disabled:opacity-30 ${
				active ? "bg-blue-500 text-white" : "hover:bg-white/15 hover:text-white"
			}`}
		>
			{icon}
		</button>
	);
}

function drawShapeOnOverlay(
	ctx: CanvasRenderingContext2D,
	shape: Shape,
	selection: Rect,
	scale: number,
	_pxCanvas: HTMLCanvasElement | null,
) {
	ctx.save();
	ctx.strokeStyle = shape.colour;
	ctx.fillStyle = shape.colour;
	ctx.lineWidth = STROKE_BASE * scale;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";

	// Convert shape points to selection relative canvas coordinates
	const pts = shape.points.map((p) => ({
		x: (p.x - selection.x) * scale,
		y: (p.y - selection.y) * scale,
	}));

	if (pts.length === 0) {
		ctx.restore();
		return;
	}

	if (shape.tool === "rect" && pts.length >= 2) {
		const p0 = pts[0]!;
		const p1 = pts[1]!;
		const x = Math.min(p0.x, p1.x);
		const y = Math.min(p0.y, p1.y);
		const w = Math.abs(p1.x - p0.x);
		const h = Math.abs(p1.y - p0.y);
		ctx.strokeRect(x, y, w, h);
	} else if (shape.tool === "ellipse" && pts.length >= 2) {
		const p0 = pts[0]!;
		const p1 = pts[1]!;
		const cx = (p0.x + p1.x) / 2;
		const cy = (p0.y + p1.y) / 2;
		const rx = Math.abs(p1.x - p0.x) / 2;
		const ry = Math.abs(p1.y - p0.y) / 2;
		ctx.beginPath();
		ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
		ctx.stroke();
	} else if (shape.tool === "arrow" && pts.length >= 2) {
		const p0 = pts[0]!;
		const p1 = pts[1]!;
		ctx.beginPath();
		ctx.moveTo(p0.x, p0.y);
		ctx.lineTo(p1.x, p1.y);
		ctx.stroke();

		// Arrow head
		const angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
		const head = 12 * scale;
		ctx.beginPath();
		ctx.moveTo(p1.x, p1.y);
		ctx.lineTo(p1.x - head * Math.cos(angle - Math.PI / 6), p1.y - head * Math.sin(angle - Math.PI / 6));
		ctx.lineTo(p1.x - head * Math.cos(angle + Math.PI / 6), p1.y - head * Math.sin(angle + Math.PI / 6));
		ctx.closePath();
		ctx.fill();
	} else if (shape.tool === "pen" && pts.length >= 1) {
		ctx.beginPath();
		ctx.moveTo(pts[0]!.x, pts[0]!.y);
		for (let i = 1; i < pts.length; i++) {
			ctx.lineTo(pts[i]!.x, pts[i]!.y);
		}
		ctx.stroke();
	}

	ctx.restore();
}
