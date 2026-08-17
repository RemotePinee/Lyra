/**
 * Drawing on top of an image, without drawing on the image.
 *
 * Marks are kept as a list of shapes and repainted from it, rather than accumulated into the
 * canvas as strokes land. That is what makes undo one line instead of a stack of bitmaps, and it
 * is what lets the in-progress shape be shown live — a rectangle you are still dragging is drawn
 * every frame from the same list plus one provisional entry, so there is no difference between
 * previewing and committing.
 *
 * The canvas is sized to the image's *natural* pixels and scaled down by CSS to whatever the
 * window can show. Pointer coordinates are converted on the way in. Doing it the other way round —
 * canvas at display size — would save the conversion and lose most of the resolution: an
 * annotation on a screenshot would come out visibly softer than the screenshot.
 */

import { Circle, Eraser, Minus, Pencil, Square, Type, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type Tool = "pen" | "line" | "rect" | "ellipse" | "text";

interface Shape {
	tool: Tool;
	colour: string;
	/** Pen keeps every point; the rest need only where the drag started and ended. */
	points: { x: number; y: number }[];
	text?: string;
}

const COLOURS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#111827"];
/** Scaled with the image so a mark on a 3000px screenshot is not a hairline. */
const STROKE_BASE = 3;

export function Annotator({
	src,
	onSave,
	onCancel,
	canReplace,
}: {
	src: string;
	onSave: (dataUrl: string) => void;
	onCancel: () => void;
	/** Whether saving can replace the original, or only produce a copy. */
	canReplace: boolean;
}) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const image = useRef<HTMLImageElement | null>(null);
	const [tool, setTool] = useState<Tool>("pen");
	const [colour, setColour] = useState(COLOURS[0]);
	const [shapes, setShapes] = useState<Shape[]>([]);
	const [drawing, setDrawing] = useState<Shape | null>(null);
	const [ready, setReady] = useState(false);

	// Load once; every repaint draws this same decoded bitmap rather than re-decoding the data URL.
	useEffect(() => {
		const img = new Image();
		img.onload = () => {
			image.current = img;
			const el = canvas.current;
			if (el) {
				el.width = img.naturalWidth;
				el.height = img.naturalHeight;
			}
			setReady(true);
		};
		img.src = src;
	}, [src]);

	// One painter for both committed and in-flight shapes — see the note at the top.
	useEffect(() => {
		const el = canvas.current;
		const img = image.current;
		if (!el || !img || !ready) return;
		const ctx = el.getContext("2d");
		if (!ctx) return;

		ctx.clearRect(0, 0, el.width, el.height);
		ctx.drawImage(img, 0, 0);
		const stroke = Math.max(STROKE_BASE, Math.round(img.naturalWidth / 500));
		for (const shape of drawing ? [...shapes, drawing] : shapes) paint(ctx, shape, stroke);
	}, [shapes, drawing, ready]);

	/** Display coordinates → image pixels, which is where the shapes live. */
	const at = (event: React.PointerEvent): { x: number; y: number } => {
		const el = canvas.current;
		if (!el) return { x: 0, y: 0 };
		const box = el.getBoundingClientRect();
		return {
			x: ((event.clientX - box.left) / box.width) * el.width,
			y: ((event.clientY - box.top) / box.height) * el.height,
		};
	};

	const start = (event: React.PointerEvent) => {
		if (tool === "text") {
			const value = window.prompt("标注文字");
			if (!value) return;
			setShapes((current) => [...current, { tool: "text", colour, points: [at(event)], text: value }]);
			return;
		}
		event.currentTarget.setPointerCapture(event.pointerId);
		setDrawing({ tool, colour, points: [at(event)] });
	};

	const move = (event: React.PointerEvent) => {
		if (!drawing) return;
		const point = at(event);
		setDrawing((current) => {
			if (!current) return current;
			// A pen accumulates; everything else is defined by its two ends.
			return current.tool === "pen"
				? { ...current, points: [...current.points, point] }
				: { ...current, points: [current.points[0], point] };
		});
	};

	const end = () => {
		if (!drawing) return;
		// A click with no drag leaves a one-point shape, which paints as nothing — drop it.
		if (drawing.points.length > 1 || drawing.tool === "pen") setShapes((current) => [...current, drawing]);
		setDrawing(null);
	};

	return (
		<div className="flex flex-col items-center gap-3">
			<canvas
				ref={canvas}
				onPointerDown={start}
				onPointerMove={move}
				onPointerUp={end}
				onPointerCancel={end}
				// Same reasoning as the viewer: a black shadow on a black backdrop is a second border.
				className="max-h-[74vh] max-w-[86vw] cursor-crosshair rounded-xl bg-white"
				style={{ touchAction: "none" }}
			/>

			{/*
			 * One bar, in the order the work happens: pick a shape, pick a colour, undo what went
			 * wrong, then leave. Grouped by separators rather than spread across two rows — a second
			 * row of controls under a picture is a second thing to look at while looking at the picture.
			 */}
			<div className="ly-composer flex items-center gap-1 rounded-xl border border-line-soft bg-float px-2 py-1.5">
				{(
					[
						["pen", Pencil, "画笔"],
						["line", Minus, "直线"],
						["rect", Square, "矩形"],
						["ellipse", Circle, "圆形"],
						["text", Type, "文字"],
					] as const
				).map(([id, Icon, label]) => (
					<button
						key={id}
						type="button"
						data-ly-tip={label}
						aria-label={label}
						aria-pressed={tool === id}
						onClick={() => setTool(id)}
						className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors duration-[var(--ly-t-quick)] ${
							tool === id ? "bg-card-hover text-ink" : "text-ink-muted hover:text-ink"
						}`}
					>
						<Icon size={14} strokeWidth={1.9} />
					</button>
				))}

				<span className="mx-1 h-4 w-px bg-line" />

				{COLOURS.map((value) => (
					<button
						key={value}
						type="button"
						aria-label={`颜色 ${value}`}
						aria-pressed={colour === value}
						onClick={() => setColour(value)}
						style={{ background: value }}
						className={`h-[18px] w-[18px] rounded-full transition-transform duration-[var(--ly-t-quick)] ${
							colour === value ? "scale-110 ring-2 ring-ink/25 ring-offset-1 ring-offset-float" : "hover:scale-110"
						}`}
					/>
				))}

				<span className="mx-1 h-4 w-px bg-line" />

				<button
					type="button"
					data-ly-tip="撤销"
					aria-label="撤销"
					disabled={shapes.length === 0}
					onClick={() => setShapes((current) => current.slice(0, -1))}
					className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:text-ink disabled:opacity-35"
				>
					<Undo2 size={14} strokeWidth={1.9} />
				</button>
				<button
					type="button"
					data-ly-tip="清空"
					aria-label="清空"
					disabled={shapes.length === 0}
					onClick={() => setShapes([])}
					className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:text-ink disabled:opacity-35"
				>
					<Eraser size={14} strokeWidth={1.9} />
				</button>

				<span className="mx-1 h-4 w-px bg-line" />

				<button
					type="button"
					onClick={onCancel}
					className="flex h-7 items-center rounded-lg px-2.5 text-detail text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:text-ink"
				>
					<X size={13} strokeWidth={2} />
				</button>
				<button
					type="button"
					disabled={shapes.length === 0}
					onClick={() => {
						const el = canvas.current;
						if (el) onSave(el.toDataURL("image/png"));
					}}
					className="flex h-7 items-center rounded-lg bg-ink px-3 text-detail font-medium text-shell transition-opacity duration-[var(--ly-t-quick)] hover:opacity-90 disabled:opacity-35"
				>
					{canReplace ? "保存" : "保存副本"}
				</button>
			</div>
		</div>
	);
}

function paint(ctx: CanvasRenderingContext2D, shape: Shape, stroke: number) {
	ctx.strokeStyle = shape.colour;
	ctx.fillStyle = shape.colour;
	ctx.lineWidth = stroke;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";

	const [first, last] = [shape.points[0], shape.points[shape.points.length - 1]];
	if (!first) return;

	if (shape.tool === "text") {
		ctx.font = `${Math.max(16, stroke * 7)}px -apple-system, system-ui, sans-serif`;
		ctx.textBaseline = "top";
		ctx.fillText(shape.text ?? "", first.x, first.y);
		return;
	}

	ctx.beginPath();
	if (shape.tool === "pen") {
		ctx.moveTo(first.x, first.y);
		for (const point of shape.points.slice(1)) ctx.lineTo(point.x, point.y);
	} else if (shape.tool === "line") {
		ctx.moveTo(first.x, first.y);
		ctx.lineTo(last.x, last.y);
	} else if (shape.tool === "rect") {
		ctx.rect(first.x, first.y, last.x - first.x, last.y - first.y);
	} else {
		// An ellipse inscribed in the drag, which is what a drag from corner to corner means.
		ctx.ellipse(
			(first.x + last.x) / 2,
			(first.y + last.y) / 2,
			Math.abs(last.x - first.x) / 2,
			Math.abs(last.y - first.y) / 2,
			0,
			0,
			Math.PI * 2,
		);
	}
	ctx.stroke();
}
