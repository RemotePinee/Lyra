/**
 * Fullscreen in-place screenshot overlay and annotator.
 *
 * Rendered when `window.location.hash` is `#/screenshot-overlay`. Shows the frozen screen, lets the
 * selection be drawn, moved and resized, and hands the annotation tools the same painter the image
 * annotator uses — see `paint.ts` for why that is shared rather than reimplemented here.
 *
 * Two coordinate spaces meet in this file and it is worth being explicit about which is which.
 * Pointer events and the selection are in CSS pixels, because that is what the overlay window is
 * measured in. Marks are in the snapshot's own pixels, because that is what `paint` and the export
 * expect, and because a mark stored that way stays anchored to the thing it was drawn on when the
 * selection is later moved. `toImage` is the only crossing point.
 */

import {
	ArrowUpRight,
	Check,
	Circle,
	Grid2x2,
	ListOrdered,
	Minus,
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
	commit,
	current,
	emptyHistory,
	mosaicBlock,
	mosaicBrush,
	redo as redoStep,
	undo as undoStep,
	type History,
	type Point,
	type Shape,
	type Tool,
} from "./annotate.ts";
import { fontOf, paintAll, strokeFor, LINE, PAD, TEXT_SCALE } from "./paint.ts";
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
	type Rect,
} from "./screenshot-geometry.ts";

const COLOURS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#ffffff", "#111827"];
/** How far from a handle still counts as grabbing it — see `hitHandle`. */
const HANDLE_GRAB = 10;
/** Roughly what the toolbar measures, only ever used to keep it on screen. Erring wide is safe. */
const TOOLBAR_SIZE = { width: 660, height: 40 };
/** The smallest drag that is a selection rather than a stray click, in CSS pixels. */
const MIN_SELECTION = 10;

/** The cursor each tool draws with; everything else uses the crosshair. */
const TOOL_CURSOR: Partial<Record<Tool, string>> = { text: "text", mosaic: "cell" };

const TOOLS: [Tool, typeof Pencil, string][] = [
	["rect", Square, "矩形 (R)"],
	["ellipse", Circle, "椭圆 (O)"],
	["arrow", ArrowUpRight, "箭头 (A)"],
	["line", Minus, "直线 (L)"],
	["pen", Pencil, "画笔 (P)"],
	["step", ListOrdered, "步骤 (S)"],
	["mosaic", Grid2x2, "马赛克 (M)"],
	["text", Type, "文字 (T)"],
];

/** The key that picks each tool, from the letters promised in the tooltips above. */
const TOOL_KEYS: Record<string, Tool> = {
	r: "rect",
	o: "ellipse",
	a: "arrow",
	l: "line",
	p: "pen",
	s: "step",
	m: "mosaic",
	t: "text",
};

/**
 * The three weights, as multipliers with the dot that stands for each.
 *
 * Light is the default, not medium. What shipped was the equivalent of the heaviest of these and
 * had no control at all — a mosaic brush over a hundred pixels wide and captions to match — so the
 * one that needs to be one press away is the one that annotates rather than obliterates.
 */
const WEIGHTS: [number, string, number][] = [
	[0.6, "细", 4],
	[1, "中", 6],
	[1.8, "粗", 9],
];

const COLOUR_NAMES: Record<string, string> = {
	"#ef4444": "红色",
	"#3b82f6": "蓝色",
	"#22c55e": "绿色",
	"#eab308": "黄色",
	"#ffffff": "白色",
	"#111827": "黑色",
};

/** Tools that are placed with one click rather than dragged out. */
const ONE_CLICK = new Set<Tool>(["step"]);
/** Tools that keep every point the pointer passed through. */
const FREEHAND = new Set<Tool>(["pen", "mosaic"]);

/**
 * What the pointer is currently doing.
 *
 * The overlay used to track only the first of these, which is why a selection could be drawn and
 * then never touched again: with no state for "the selection exists and the pointer is on it",
 * there was nowhere for moving or resizing to live.
 */
type Gesture =
	| { kind: "idle" }
	| { kind: "drawing"; from: Point }
	| { kind: "moving"; from: Point; origin: Rect }
	| { kind: "resizing"; handle: Handle };

/** A caption being typed, before it becomes a shape. Positions are in image pixels. */
interface Typing {
	at: Point;
	value: string;
	width: number;
}

export function ScreenshotOverlay() {
	const [snapshot, setSnapshot] = useState<string | null>(null);
	/** The snapshot has decoded and can be drawn. See where it is set for why this is state. */
	const [imageReady, setImageReady] = useState(false);
	const [scaleFactor, setScaleFactor] = useState(2);
	const [settings, setSettings] = useState<ScreenshotSettings | undefined>(undefined);

	// The selection, in CSS pixels of this window.
	const [selection, setSelection] = useState<Rect | null>(null);
	const [gesture, setGesture] = useState<Gesture>({ kind: "idle" });

	const [tool, setTool] = useState<Tool | null>(null);
	const [colour, setColour] = useState(COLOURS[0]!);
	const [history, setHistory] = useState<History>(emptyHistory);
	/** The mark under the pointer right now, committed on release. */
	const [drawing, setDrawing] = useState<Shape | null>(null);
	const [typing, setTyping] = useState<Typing | null>(null);

	const rootRef = useRef<HTMLDivElement>(null);
	const bgCanvasRef = useRef<HTMLCanvasElement>(null);
	const markCanvasRef = useRef<HTMLCanvasElement>(null);
	const fieldRef = useRef<HTMLTextAreaElement>(null);
	const imageRef = useRef<HTMLImageElement | null>(null);
	/** The snapshot averaged down to one pixel per mosaic block, and the block size it was built at. */
	const mosaicRef = useRef<{ pixels: HTMLCanvasElement; block: number; brush: number } | null>(null);

	/**
	 * How heavy the marks are, as a multiplier on everything that has a size.
	 *
	 * There was no control at all: stroke, type and the mosaic brush were all derived from the
	 * screen's pixel width and that was that. On a Retina display that put the brush at over a
	 * hundred pixels — a redaction that covers half a paragraph to hide one word — and set captions
	 * at a size nothing could be said about. One number moves all three together, so a heavy mark
	 * and heavy text stay in proportion to each other.
	 */
	const [weight, setWeight] = useState(0.6);

	/** Stroke and type size, scaled to the snapshot like every other mark, times the chosen weight. */
	const base = strokeFor(imageRef.current?.naturalWidth ?? 1920);
	const stroke = Math.max(1, base * weight);
	const typeSize = stroke * TEXT_SCALE;
	const brush = Math.max(4, (mosaicRef.current?.brush ?? 16) * weight);

	// 1. The main process hands over the frozen screen.
	useEffect(() => {
		return window.lyra.screenshot.onInit((data) => {
			setSnapshot(data.snapshot);
			setScaleFactor(data.scaleFactor || 2);
			setSettings(data.settings);

			const img = new Image();
			img.onload = () => {
				imageRef.current = img;

				/*
				 * The mosaic source, averaged down and back up at paint time.
				 *
				 * Built at exactly `mosaicBlock`'s size rather than a number of its own: `paintMosaic`
				 * indexes this canvas as `x / block`, so a source built at a different block reads the
				 * wrong pixel for every cell. They were different, which is one of the reasons the
				 * mosaic tool did nothing recognisable.
				 */
				const block = mosaicBlock(img.naturalWidth);
				const pixels = document.createElement("canvas");
				pixels.width = Math.max(1, Math.ceil(img.naturalWidth / block));
				pixels.height = Math.max(1, Math.ceil(img.naturalHeight / block));
				const ctx = pixels.getContext("2d", { willReadFrequently: true });
				if (ctx) {
					ctx.imageSmoothingEnabled = true;
					ctx.drawImage(img, 0, 0, pixels.width, pixels.height);
				}
				mosaicRef.current = { pixels, block, brush: mosaicBrush(img.naturalWidth) };

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

	// 2. The frozen screen, dimmed outside the selection.
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

		ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
		if (!selection || selection.width === 0 || selection.height === 0) {
			ctx.fillRect(0, 0, canvas.width, canvas.height);
		} else {
			ctx.beginPath();
			ctx.rect(0, 0, canvas.width, canvas.height);
			ctx.rect(
				selection.x * scaleFactor,
				selection.y * scaleFactor,
				selection.width * scaleFactor,
				selection.height * scaleFactor,
			);
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

	// 3. The marks, including the one still under the pointer.
	useEffect(() => {
		const canvas = markCanvasRef.current;
		if (!canvas || !selection) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		canvas.width = Math.max(1, Math.round(selection.width * scaleFactor));
		canvas.height = Math.max(1, Math.round(selection.height * scaleFactor));
		ctx.clearRect(0, 0, canvas.width, canvas.height);

		/*
		 * Marks are in the snapshot's coordinates and this canvas covers only the selection, so the
		 * whole difference between the two is one translate. Doing it here rather than offsetting
		 * every point is what lets `paint` be shared with the annotator unchanged.
		 */
		ctx.save();
		ctx.translate(-selection.x * scaleFactor, -selection.y * scaleFactor);
		const mosaic = mosaicRef.current;
		paintAll(ctx, drawing ? [...current(history), drawing] : current(history), {
			stroke,
			pixels: mosaic?.pixels ?? null,
			block: mosaic?.block ?? 8,
			brush,
		});
		ctx.restore();
	}, [history, drawing, selection, scaleFactor, stroke, brush]);

	// The caption field takes focus as it appears, and grows to fit what is typed into it.
	useEffect(() => {
		const el = fieldRef.current;
		if (!el || !typing) return;
		if (document.activeElement !== el) el.focus();
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [typing]);

	/** Pointer position → the snapshot's own pixels, which is where marks live. */
	const toImage = useCallback(
		(at: Point): Point => ({ x: at.x * scaleFactor, y: at.y * scaleFactor }),
		[scaleFactor],
	);

	/**
	 * Turn the open caption into a mark.
	 *
	 * Two plain calls rather than one nested in a state updater: React runs an updater more than
	 * once per commit, so committing from inside `setTyping` lands the caption twice.
	 */
	const commitText = useCallback(() => {
		if (!typing) return;
		const { at, value, width } = typing;
		const height = fieldRef.current ? (fieldRef.current.offsetHeight * scaleFactor) : typeSize * LINE;
		setTyping(null);
		if (!value.trim()) return;
		setHistory((h) =>
			commit(h, [
				...current(h),
				{ tool: "text", colour, points: [at], text: value, size: typeSize, width, height },
			]),
		);
	}, [typing, colour, typeSize, scaleFactor]);

	/** What the pointer would do if it were pressed here — kept off React, it changes every frame. */
	const showCursor = useCallback(
		(at: Point) => {
			const el = rootRef.current;
			if (!el) return;
			let cursor = "crosshair";
			if (selection) {
				const handle = hitHandle(selection, at, HANDLE_GRAB);
				if (handle) cursor = HANDLE_CURSOR[handle];
				else if (insideRect(selection, at)) cursor = tool ? (TOOL_CURSOR[tool] ?? "crosshair") : "move";
			}
			if (el.style.cursor !== cursor) el.style.cursor = cursor;
		},
		[selection, tool],
	);

	const onMouseDown = (e: React.MouseEvent) => {
		if (e.button !== 0) return;
		const at = { x: e.clientX, y: e.clientY };

		/*
		 * A caption in progress is finished by pressing anywhere else, and that press does nothing
		 * else.
		 *
		 * Letting it fall through meant the click that ended one caption immediately opened another
		 * empty one under the pointer, so finishing a caption always left a stray box behind. One
		 * click, one thing.
		 */
		if (typing) {
			commitText();
			return;
		}

		if (selection) {
			// Handles first, so a selection can always be resized even with a tool in hand.
			const handle = hitHandle(selection, at, HANDLE_GRAB);
			if (handle) {
				setGesture({ kind: "resizing", handle });
				return;
			}

			if (insideRect(selection, at)) {
				/*
				 * A tool takes precedence inside the selection, and only there.
				 *
				 * This used to be `if (tool) return` at the top of the handler, which is why
				 * annotating never worked at all: the press was swallowed and no code path anywhere
				 * created a shape. Outside the selection a tool is not what the click means.
				 */
				if (tool === "text") {
					const image = toImage(at);
					setTyping({ at: image, value: "", width: Math.max(typeSize * 8, selection.width * scaleFactor * 0.4) });
					return;
				}
				if (tool) {
					const image = toImage(at);
					setDrawing({ tool, colour, points: [image] });
					return;
				}
				setGesture({ kind: "moving", from: at, origin: selection });
				return;
			}
		}

		// Anywhere else starts over.
		setGesture({ kind: "drawing", from: at });
		setSelection({ x: at.x, y: at.y, width: 0, height: 0 });
	};

	const onMouseMove = (e: React.MouseEvent) => {
		const at = { x: e.clientX, y: e.clientY };
		const viewport = { width: window.innerWidth, height: window.innerHeight };

		if (drawing) {
			const point = toImage(at);
			setDrawing((shape) => {
				if (!shape) return shape;
				/*
				 * A pen keeps every point it passed through; everything else is defined by where the
				 * drag started and where it is now, so the second point is replaced rather than
				 * appended — a rectangle otherwise accumulates a thousand corners.
				 */
				const points = FREEHAND.has(shape.tool)
					? [...shape.points, point]
					: [shape.points[0]!, point];
				return { ...shape, points };
			});
			return;
		}

		switch (gesture.kind) {
			case "drawing":
				setSelection(clampRect(rectFromPoints(gesture.from, at), viewport));
				return;
			case "moving":
				setSelection(moveRect(gesture.origin, at.x - gesture.from.x, at.y - gesture.from.y, viewport));
				return;
			case "resizing":
				setSelection((rect) => (rect ? clampRect(resizeRect(rect, gesture.handle, at), viewport) : rect));
				return;
			default:
				showCursor(at);
		}
	};

	const onMouseUp = () => {
		if (drawing) {
			// A tap with no drag draws nothing, except for the tools that are placed with one click.
			if (drawing.points.length > 1 || ONE_CLICK.has(drawing.tool)) {
				const shape = drawing;
				setHistory((h) => commit(h, [...current(h), shape]));
			}
			setDrawing(null);
			return;
		}

		// A stray click is not a selection: it is how someone cancels the one they had.
		if (gesture.kind === "drawing" && selection) {
			if (selection.width < MIN_SELECTION || selection.height < MIN_SELECTION) setSelection(null);
		}
		setGesture({ kind: "idle" });
	};

	/** The selection and its marks, at the snapshot's own resolution. */
	const handleFinish = useCallback(async () => {
		if (!selection || !imageRef.current) return;

		const out = document.createElement("canvas");
		const sx = selection.x * scaleFactor;
		const sy = selection.y * scaleFactor;
		out.width = Math.max(1, Math.round(selection.width * scaleFactor));
		out.height = Math.max(1, Math.round(selection.height * scaleFactor));
		const ctx = out.getContext("2d");
		if (!ctx) return;

		ctx.drawImage(imageRef.current, sx, sy, out.width, out.height, 0, 0, out.width, out.height);

		ctx.translate(-sx, -sy);
		const mosaic = mosaicRef.current;
		paintAll(ctx, current(history), {
			stroke,
			pixels: mosaic?.pixels ?? null,
			block: mosaic?.block ?? 8,
			brush,
		});

		await window.lyra.screenshot.finish(out.toDataURL("image/png"), settings);
	}, [selection, scaleFactor, history, settings, stroke, brush]);

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			// While a caption is open the keyboard belongs to it — Escape closes the field rather
			// than throwing away the screenshot, and every letter is a letter.
			if (typing) {
				if (e.key === "Escape") {
					e.preventDefault();
					setTyping(null);
				} else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
					e.preventDefault();
					commitText();
				}
				return;
			}

			if (e.key === "Escape") {
				e.preventDefault();
				void window.lyra.screenshot.cancel();
				return;
			}
			if (e.key === "Enter" && selection && selection.width > MIN_SELECTION && selection.height > MIN_SELECTION) {
				e.preventDefault();
				void handleFinish();
				return;
			}
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
				e.preventDefault();
				setHistory((h) => (e.shiftKey ? redoStep(h) : undoStep(h)));
				return;
			}
			if (e.metaKey || e.ctrlKey || e.altKey) return;

			// The letters the tooltips have always promised. They did nothing until now: the toolbar
			// said "矩形 (R)" and R was not bound to anything.
			const picked = TOOL_KEYS[e.key.toLowerCase()];
			if (picked && selection) {
				e.preventDefault();
				setTool((active) => (active === picked ? null : picked));
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [selection, handleFinish, typing, commitText]);

	if (!snapshot) return null;

	const toolbar = selection
		? toolbarPosition(selection, { width: window.innerWidth, height: window.innerHeight }, TOOLBAR_SIZE)
		: null;

	return (
		<div
			ref={rootRef}
			className="relative h-screen w-screen overflow-hidden select-none cursor-crosshair"
			onMouseDown={onMouseDown}
			onMouseMove={onMouseMove}
			onMouseUp={onMouseUp}
		>
			<canvas ref={bgCanvasRef} className="absolute inset-0 h-full w-full pointer-events-none" />

			{selection && (
				<div
					className="absolute border border-blue-500 pointer-events-none"
					style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }}
				>
					{/*
					 * The size in real pixels, which is what the saved file will be.
					 *
					 * Above the selection, or just inside it when there is no room above — a
					 * selection started at the top of the screen otherwise pushes the badge off it,
					 * and the one time the number matters most is while the edge is being dragged.
					 */}
					<div
						className="absolute left-0 rounded bg-black/75 px-2 py-0.5 text-xs text-white tabular-nums"
						style={{ top: selection.y >= 28 ? -28 : 4 }}
					>
						{Math.round(selection.width * scaleFactor)} × {Math.round(selection.height * scaleFactor)}
					</div>

					<canvas ref={markCanvasRef} className="absolute inset-0 h-full w-full pointer-events-none" />
				</div>
			)}

			{/*
			 * The grips, drawn only when the selection is settled.
			 *
			 * Outside the selection's own element so they are not clipped by it — half of each one
			 * sits outside the edge it belongs to, which is what makes it look like a grip rather
			 * than a decoration inside the crop.
			 */}
			{selection && gesture.kind === "idle" && !drawing && selection.width > 0 && selection.height > 0 && (
				<>
					{HANDLES.map((handle) => {
						const at = handlePoint(selection, handle);
						return (
							<div
								key={handle}
								className="pointer-events-none absolute h-2 w-2 rounded-[1px] border border-white bg-blue-500 shadow"
								style={{ left: at.x - 4, top: at.y - 4 }}
							/>
						);
					})}
				</>
			)}

			{/* A caption being typed, in place and at the size it will be painted. */}
			{typing && (
				<textarea
					ref={fieldRef}
					value={typing.value}
					onChange={(e) => setTyping((entry) => (entry ? { ...entry, value: e.target.value } : entry))}
					onMouseDown={(e) => e.stopPropagation()}
					placeholder="输入文字…"
					spellCheck={false}
					className="pointer-events-auto absolute z-40 resize-none overflow-hidden rounded border border-blue-400/80 bg-black/25 outline-none select-text"
					style={{
						left: typing.at.x / scaleFactor,
						top: typing.at.y / scaleFactor,
						width: typing.width / scaleFactor,
						color: colour,
						font: fontOf(typeSize / scaleFactor),
						lineHeight: LINE,
						padding: `${(typeSize * PAD) / scaleFactor}px`,
					}}
				/>
			)}

			{/*
			 * The toolbar, under the selection and aligned to its left edge.
			 *
			 * Hidden while the pointer is shaping the selection or drawing — during a drag it would
			 * be chasing the cursor, and it is not what anyone is looking at. Placement comes from
			 * `toolbarPosition`, which keeps it on screen from any corner and is tested rather than
			 * eyeballed; it used to be a hard-coded right-alignment that ran off the left edge for
			 * any selection narrower than the toolbar.
			 */}
			{selection && toolbar && selection.width > 20 && selection.height > 20 && gesture.kind === "idle" && !drawing && (
				<div
					className="pointer-events-auto absolute z-50 flex items-center gap-1 rounded-xl border border-white/15 bg-neutral-900/90 p-1.5 shadow-2xl backdrop-blur-md"
					style={{ left: toolbar.x, top: toolbar.y }}
					onMouseDown={(e) => e.stopPropagation()}
					onMouseMove={(e) => e.stopPropagation()}
				>
					{TOOLS.map(([name, Icon, tip]) => (
						<ToolButton
							key={name}
							icon={<Icon size={16} />}
							active={tool === name}
							tip={tip}
							onClick={() => setTool(tool === name ? null : name)}
						/>
					))}

					<Divider />

					{/*
					 * Weight, shown as what it does rather than named.
					 *
					 * Three dots at the sizes they produce: the control is a preview of the mark. A
					 * caption, a stroke and a mosaic brush all move together, because a heavy mark
					 * beside hairline text reads as two different annotations of the same picture.
					 */}
					<div className="flex items-center gap-0.5" data-ly-tip="粗细">
						{WEIGHTS.map(([value, label, dot]) => (
							<button
								key={label}
								type="button"
								onClick={() => setWeight(value)}
								data-ly-tip={label}
								className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
									weight === value ? "bg-blue-500" : "hover:bg-white/15"
								}`}
							>
								<span className="rounded-full bg-white" style={{ width: dot, height: dot }} />
							</button>
						))}
					</div>

					<Divider />

					<div className="flex items-center gap-1">
						{COLOURS.map((c) => (
							<button
								key={c}
								type="button"
								onClick={() => setColour(c)}
								data-ly-tip={COLOUR_NAMES[c] ?? c}
								className={`h-4 w-4 rounded-full border border-black/40 transition-transform ${
									colour === c ? "scale-125 ring-2 ring-white" : "hover:scale-110"
								}`}
								style={{ backgroundColor: c }}
							/>
						))}
					</div>

					<Divider />

					<ToolButton
						icon={<Undo2 size={16} />}
						disabled={!canUndo(history)}
						tip="撤销 (⌘Z)"
						onClick={() => setHistory((h) => undoStep(h))}
					/>
					<ToolButton
						icon={<Redo2 size={16} />}
						disabled={!canRedo(history)}
						tip="重做 (⇧⌘Z)"
						onClick={() => setHistory((h) => redoStep(h))}
					/>

					<Divider />

					<ToolButton icon={<X size={16} />} tip="取消 (ESC)" onClick={() => void window.lyra.screenshot.cancel()} />
					<button
						type="button"
						onClick={() => void handleFinish()}
						className="flex items-center gap-1 rounded-lg bg-blue-500 px-3 py-1 text-xs font-semibold text-white shadow transition-colors hover:bg-blue-600"
					>
						<Check size={14} strokeWidth={2.5} />
						完成
					</button>
				</div>
			)}
		</div>
	);
}

const Divider = () => <span className="mx-1 h-4 w-px shrink-0 bg-white/20" />;

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
