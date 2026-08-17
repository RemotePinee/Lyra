/**
 * Drawing on top of an image, without drawing on the image.
 *
 * Marks are kept as a list of shapes and repainted from it, rather than accumulated into the canvas
 * as strokes land. That is what makes undo and redo a cursor into a list instead of a stack of
 * bitmaps, it is what lets step badges renumber themselves when one is undone, and it is what lets
 * the in-progress shape be shown live — a rectangle you are still dragging is drawn every frame from
 * the same list plus one provisional entry, so previewing and committing are the same code.
 *
 * The canvas is sized to the image's *natural* pixels and scaled down by CSS. Pointer coordinates
 * are converted on the way in, through `getBoundingClientRect`, which already accounts for the zoom
 * transform on the stage above it — so drawing at 400% lands where the pointer is without the zoom
 * appearing anywhere in this file.
 *
 * Split into a hook, a canvas and a toolbar because the toolbar cannot live inside the canvas's
 * parent: the stage is transformed for zooming, and `position: fixed` inside a transformed ancestor
 * is fixed to that ancestor rather than to the window. A toolbar that scaled and slid with the
 * picture it is being used to annotate would be unusable at 400%.
 */

import {
	ArrowUpRight,
	MousePointer2,
	Circle,
	Grid2x2,
	ListOrdered,
	Minus,
	Pencil,
	Redo2,
	Square,
	Trash2,
	Type,
	Undo2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
	canRedo,
	canUndo,
	commit,
	current,
	emptyHistory,
	handlesOf,
	hitShape,
	mosaicBlock,
	mosaicBrush,
	mosaicCells,
	moveShape,
	pickTolerance,
	redo,
	resizeShape,
	shapeBounds,
	stepNumber,
	undo,
	WIDTH_HANDLE,
	wrapText,
	type History,
	type Point,
	type Shape,
	type Tool,
} from "./annotate.ts";

const COLOURS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#111827"];
/** Scaled with the image, so a mark on a 3000px screenshot is not a hairline. */
const STROKE_BASE = 3;
/** Type size relative to the stroke, which is itself relative to the image. */
const TEXT_SCALE = 7;

/** Where a piece of text is being typed, in natural pixels, before it becomes a shape. */
interface Typing {
	at: Point;
	value: string;
	/** The column it wraps at, dragged by the handle on its edge. */
	width: number;
	/**
	 * The caption this one replaces, when an existing mark is being edited rather than a new one
	 * written. It is hidden from the paint while it is being edited, so it is not drawn twice.
	 */
	replacing?: number;
}

/** A mark being dragged: which one, where the drag started, and where it has got to. */
interface Dragging {
	index: number;
	from: Point;
	moving: Shape;
	/** Which grip is being pulled, or null when the whole mark is being moved. */
	handle: number | null;
	/**
	 * Whether it has actually gone anywhere.
	 *
	 * A click that selects is a drag of zero length, and committing that would put a step in the
	 * history that changes nothing — undo would appear not to work until pressed twice.
	 */
	moved: boolean;
}

/**
 * Marks that are worth selecting the moment they are drawn.
 *
 * Everything except the two free strokes. A rectangle is almost never the right rectangle first
 * time, so handing it back with grips on saves the round trip through the selection tool that this
 * whole arrangement exists to remove. A pen stroke, on the other hand, is usually one of several in
 * a row, and selecting each one would put a box around every scribble as it is made.
 */
const SELECT_ON_DRAW = new Set<Tool>(["rect", "ellipse", "line", "arrow", "step"]);

/** Line spacing and padding, shared by the field and the paint so the two agree exactly. */
const LINE = 1.35;
const PAD = 0.28;

/** What can sit behind a caption. Transparent first, because most captions want nothing. */
const BACKDROPS: [string | undefined, string][] = [
	[undefined, "透明"],
	["#ffffffe6", "白色"],
	["#111827e6", "黑色"],
	["#fde68ae6", "浅黄"],
];

const FONT = `-apple-system, system-ui, "PingFang SC", sans-serif`;
/** One string, so the field and the canvas cannot drift apart. */
const fontOf = (size: number) => `${Math.max(12, size)}px ${FONT}`;

export interface Annotator {
	tool: Tool;
	setTool: (tool: Tool) => void;
	colour: string;
	setColour: (colour: string) => void;
	/** What sits behind a caption; undefined is nothing at all. */
	backdrop: string | undefined;
	setBackdrop: (backdrop: string | undefined) => void;
	undo: () => void;
	redo: () => void;
	clear: () => void;
	canUndo: boolean;
	canRedo: boolean;
	dirty: boolean;
	/** Which mark is selected, or null. An index into the current state's list. */
	selected: number | null;
	setSelected: (index: number | null) => void;
	removeSelected: () => void;
	/** The annotated image as a PNG data URL, or null before the source has decoded. */
	render: () => string | null;
	// Internals the canvas needs; not for callers.
	shapes: Shape[];
	canvas: React.RefObject<HTMLCanvasElement | null>;
	setHistory: React.Dispatch<React.SetStateAction<History>>;
	image: React.RefObject<HTMLImageElement | null>;
	/** The image redrawn at one pixel per mosaic block, which is where the mosaic samples from. */
	pixels: React.RefObject<HTMLCanvasElement | null>;
	ready: boolean;
	/**
	 * The source's natural width, in state rather than read off the ref.
	 *
	 * Every size in here — stroke, type, mosaic block — is derived from it, and deriving them from
	 * `image.current` means the derivation has no honest dependency: a ref cannot be one, and the
	 * `ready` flag standing in for it is a lie the linter is right to reject.
	 */
	width: number;
}

export function useAnnotator(src: string): Annotator {
	const canvas = useRef<HTMLCanvasElement>(null);
	const image = useRef<HTMLImageElement | null>(null);
	const pixels = useRef<HTMLCanvasElement | null>(null);
	const [tool, setTool] = useState<Tool>("pen");
	const [colour, setColour] = useState(COLOURS[0]!);
	const [backdrop, setBackdrop] = useState<string | undefined>(undefined);
	const [history, setHistory] = useState<History>(emptyHistory);
	const [selected, setSelected] = useState<number | null>(null);
	const [ready, setReady] = useState(false);
	const [width, setWidth] = useState(0);

	// Load once; every repaint draws this same decoded bitmap rather than re-decoding the data URL.
	useEffect(() => {
		setReady(false);
		setHistory(emptyHistory());
		setSelected(null);
		// The viewer passes "" while it is only showing the picture. Setting an empty `src` on an
		// Image resolves against the document URL and fetches the page itself, so it is not a
		// harmless no-op — it has to be skipped rather than allowed to fail.
		if (!src) return;
		const img = new Image();
		img.onload = () => {
			image.current = img;
			const el = canvas.current;
			if (el) {
				el.width = img.naturalWidth;
				el.height = img.naturalHeight;
			}

			/*
			 * The mosaic source, built once.
			 *
			 * Drawing the whole image into a canvas one pixel per block gives, in a single call, the
			 * average colour of every block — which is what a mosaic is. Painting a block is then
			 * blitting one pixel of it back at block size with smoothing off. The alternative, reading
			 * pixels and averaging them per block per frame, is the same answer computed thousands of
			 * times a second.
			 */
			const block = mosaicBlock(img.naturalWidth);
			const small = document.createElement("canvas");
			small.width = Math.max(1, Math.ceil(img.naturalWidth / block));
			small.height = Math.max(1, Math.ceil(img.naturalHeight / block));
			small.getContext("2d")?.drawImage(img, 0, 0, small.width, small.height);
			pixels.current = small;

			setWidth(img.naturalWidth);
			setReady(true);
		};
		img.src = src;
		return () => {
			img.onload = null;
		};
	}, [src]);

	const shapes = current(history);

	/*
	 * Anything that changes the list clears the selection.
	 *
	 * A selection is an index, and an index only means something against the list it was taken
	 * from. After an undo the list is a different one: the same index is a different mark, or none
	 * at all, and a selection box would be drawn around something the user did not select. Clearing
	 * is both correct and what every editor does — undo puts you back, it does not keep your hands
	 * where they were.
	 */
	const step = useCallback((change: (h: History) => History) => {
		setSelected(null);
		setHistory(change);
	}, []);

	return {
		tool,
		setTool: useCallback((next: Tool) => {
			// A selection belongs to the selecting tool; keeping it while a pen is chosen would leave
			// a box around something the next click is not going to affect.
			if (next !== "select") setSelected(null);
			setTool(next);
		}, []),
		colour,
		setColour,
		backdrop,
		setBackdrop,
		undo: useCallback(() => step(undo), [step]),
		redo: useCallback(() => step(redo), [step]),
		clear: useCallback(() => step((h) => (current(h).length === 0 ? h : commit(h, []))), [step]),
		canUndo: canUndo(history),
		canRedo: canRedo(history),
		dirty: shapes.length > 0,
		selected,
		setSelected,
		// Two plain calls rather than one inside the other's updater: an updater has to be pure,
		// because React runs it more than once per commit. This is the same trap that made a caption
		// commit twice, and it is worth writing out longhand every time.
		removeSelected: useCallback(() => {
			if (selected === null) return;
			setHistory((h) => {
				const list = current(h);
				return selected < list.length ? commit(h, list.filter((_, i) => i !== selected)) : h;
			});
			setSelected(null);
		}, [selected]),
		render: useCallback(() => canvas.current?.toDataURL("image/png") ?? null, []),
		shapes,
		canvas,
		setHistory,
		image,
		pixels,
		ready,
		width,
	};
}

// ---------------------------------------------------------------------------
// The canvas
// ---------------------------------------------------------------------------

/** Shared with the viewer's `<img>` so entering edit mode does not resize the picture by a pixel. */
export const STAGE_FIT = "max-h-[86vh] max-w-[86vw]";

const CURSOR: Partial<Record<Tool, string>> = {
	select: "cursor-default",
	text: "cursor-text",
	step: "cursor-copy",
	mosaic: "cursor-cell",
};

export function AnnotateCanvas({ annotator, zoom }: { annotator: Annotator; zoom: number }) {
	const { canvas, image, pixels, ready, width, tool, colour, backdrop, shapes, setHistory, selected, setSelected } =
		annotator;
	const [drawing, setDrawing] = useState<Shape | null>(null);
	const [typing, setTyping] = useState<Typing | null>(null);
	const [dragging, setDragging] = useState<Dragging | null>(null);
	const [hovering, setHovering] = useState<"move" | "point" | "width" | null>(null);
	const field = useRef<HTMLTextAreaElement>(null);
	const sizing = useRef<{ x: number; from: number; scale: number } | null>(null);
	const carrying = useRef<{ x: number; y: number; from: Point; scale: number } | null>(null);

	const stroke = Math.max(STROKE_BASE, Math.round(width / 500));
	const typeSize = stroke * TEXT_SCALE;

	/*
	 * Image pixels → display pixels, read during render rather than stored.
	 *
	 * Declared up here because `commitText` closes over it: a `useCallback` dependency array is
	 * evaluated as the component renders, so a `const` defined further down is still in its temporal
	 * dead zone by the time the array is built.
	 */
	const display = canvas.current && canvas.current.width > 0 ? canvas.current.clientWidth / canvas.current.width : 1;

	/*
	 * Sized on attach as well as on load, which is what stops the flash.
	 *
	 * A canvas with no width attribute is 300×150. Entering edit mode mounted one at that size and
	 * corrected it when the image finished decoding, so there was a frame — sometimes several — where
	 * a small white box stood in for the picture. Now the viewer keeps the image decoded while it is
	 * merely being looked at, so by the time this mounts the natural size is already known and can be
	 * applied in the same breath as the element appearing.
	 */
	const attach = useCallback(
		(el: HTMLCanvasElement | null) => {
			canvas.current = el;
			const img = image.current;
			if (el && img && el.width !== img.naturalWidth) {
				el.width = img.naturalWidth;
				el.height = img.naturalHeight;
			}
		},
		[canvas, image],
	);

	/**
	 * What is actually on screen: the committed marks, with the one being dragged shown where it is
	 * being dragged to, and the one being re-edited taken out because the field is standing in for it.
	 */
	const live = useMemo(() => {
		const list = shapes
			.map((shape, index) => (dragging?.index === index ? dragging.moving : shape))
			.filter((_, index) => index !== typing?.replacing);
		return drawing ? [...list, drawing] : list;
	}, [shapes, drawing, dragging, typing?.replacing]);

	/** The selected mark as it currently looks, which during a drag is not what is committed. */
	const chosen = selected === null ? null : (dragging?.index === selected ? dragging.moving : shapes[selected]) ?? null;
	const grips = chosen ? handlesOf(chosen) : [];

	/*
	 * The canvas carries only what will be saved.
	 *
	 * The selection box is drawn in the DOM, a few lines below, rather than here. Painting it onto
	 * the canvas would mean `toDataURL` picked it up, and the fix for that — repaint without it,
	 * grab the URL, repaint with it — is a second rendering path that exists only to be forgotten
	 * about later. An element over the canvas cannot end up in the file.
	 */
	useEffect(() => {
		const el = canvas.current;
		const img = image.current;
		if (!el || !img || !ready) return;
		const ctx = el.getContext("2d");
		if (!ctx) return;

		ctx.clearRect(0, 0, el.width, el.height);
		ctx.drawImage(img, 0, 0);

		const block = mosaicBlock(width);
		const brush = mosaicBrush(width);
		live.forEach((shape, index) => {
			if (shape.tool === "mosaic") paintMosaic(ctx, shape, pixels.current, block, brush);
			else paint(ctx, shape, stroke, stepNumber(live, index));
		});
	}, [live, ready, width, stroke, canvas, image, pixels]);

	// Focused on appearing, so typing can start immediately; and grown to fit its content on every
	// keystroke, so the box is always exactly as tall as what is in it.
	useEffect(() => {
		const el = field.current;
		if (!el || !typing) return;
		if (document.activeElement !== el) el.focus();
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [typing]);

	/** Display coordinates → image pixels, which is where the shapes live. */
	// Takes anything with client coordinates, so a double-click can be located the same way a
	// pointer press is without either knowing about the other's event type.
	const at = useCallback(
		(event: { clientX: number; clientY: number }): Point => {
			const el = canvas.current;
			if (!el) return { x: 0, y: 0 };
			// The rect already includes the stage's zoom transform, so this is correct at any zoom.
			const box = el.getBoundingClientRect();
			return {
				x: ((event.clientX - box.left) / box.width) * el.width,
				y: ((event.clientY - box.top) / box.height) * el.height,
			};
		},
		[canvas],
	);

	/*
	 * Two plain calls, not one nested inside a state updater.
	 *
	 * Reaching for `setTyping(entry => { setHistory(...); return null })` reads as a way to get at
	 * the current entry without listing it as a dependency, and it is wrong: an updater has to be a
	 * pure function of the state, because React calls it more than once per commit — twice under
	 * StrictMode. The caption was therefore committed twice, landing two identical shapes on the
	 * same spot. Nothing looked wrong; it took two presses of undo to remove one caption.
	 */
	const commitText = useCallback(() => {
		if (!typing) return;
		const { at: where, value, width: column, replacing } = typing;
		// Measured from the field that typed it, so the box that can be selected later is exactly the
		// box that was seen. Falls back to one line if the element has already gone.
		const height = field.current ? field.current.offsetHeight / (display || 1) : typeSize * LINE;

		setHistory((h) => {
			const list = current(h);
			const written = value.trim();

			if (replacing !== undefined) {
				if (replacing >= list.length) return h;
				// Emptying an existing caption removes it. Anything else would leave an invisible mark
				// that can still be selected, which is worse than either outcome the user meant.
				if (!written) return commit(h, list.filter((_, i) => i !== replacing));
				return commit(
					h,
					list.map((shape, i) =>
						i === replacing
							? { ...shape, colour, points: [where], text: value, size: typeSize, width: column, height, background: backdrop }
							: shape,
					),
				);
			}

			if (!written) return h;
			return commit(h, [
				...list,
				{ tool: "text", colour, points: [where], text: value, size: typeSize, width: column, height, background: backdrop },
			]);
		});
		setTyping(null);
	}, [typing, setHistory, colour, typeSize, backdrop, display]);

	/** Put an existing caption back into the field it came from. */
	const editText = useCallback(
		(index: number) => {
			const shape = shapes[index];
			if (!shape || shape.tool !== "text") return false;
			annotator.setColour(shape.colour);
			annotator.setBackdrop(shape.background);
			setSelected(null);
			setTyping({
				at: shape.points[0] ?? { x: 0, y: 0 },
				value: shape.text ?? "",
				width: shape.width ?? Math.max(160, Math.round(width * 0.3)),
				replacing: index,
			});
			return true;
		},
		[shapes, annotator, setSelected, width],
	);

	const start = (event: React.PointerEvent) => {
		if (event.button !== 0) return;
		const point = at(event);

		const tolerance = pickTolerance(stroke, zoom);

		/*
		 * The selected mark is grabbable under *every* tool, not only under the selecting one.
		 *
		 * This is the whole point of the arrangement. Drawing a rectangle and then wanting it two
		 * centimetres to the left used to mean: switch to the selecting tool, drag, switch back. Three
		 * actions for one adjustment, every time, and the same again for the next rectangle. Here the
		 * mark you just drew is still live: press on it to move it, press on a grip to resize it,
		 * press anywhere else and you are drawing the next one. Nothing has to be switched.
		 *
		 * Only the *selected* mark, deliberately. If every mark were grabbable, a pen stroke across
		 * one already on the picture would move it instead of drawing, and the tool in your hand
		 * would stop meaning what it says.
		 */
		if (chosen && selected !== null) {
			const grip = grips.find((g) => Math.hypot(g.at.x - point.x, g.at.y - point.y) <= tolerance * 1.8);
			if (grip) {
				event.currentTarget.setPointerCapture(event.pointerId);
				setDragging({ index: selected, from: point, moving: chosen, handle: grip.index, moved: false });
				return;
			}
			if (hitShape([chosen], point, tolerance) === 0) {
				event.currentTarget.setPointerCapture(event.pointerId);
				setDragging({ index: selected, from: point, moving: chosen, handle: null, moved: false });
				return;
			}
		}

		/*
		 * Selecting and moving are one gesture.
		 *
		 * Pressing on a mark selects it *and* begins the drag, so moving something takes one gesture
		 * rather than a click to select followed by a drag to move. Pressing on nothing clears the
		 * selection, which is the only other thing a press on empty space could mean.
		 */
		if (tool === "select") {
			if (typing) commitText();
			const index = hitShape(shapes, point, tolerance);
			setSelected(index < 0 ? null : index);
			if (index >= 0) {
				event.currentTarget.setPointerCapture(event.pointerId);
				setDragging({ index, from: point, moving: shapes[index]!, handle: null, moved: false });
			}
			return;
		}

		// Drawing somewhere else means that mark is finished with.
		if (selected !== null) setSelected(null);

		if (tool === "text") {
			/*
			 * A field on the picture, not a `window.prompt`.
			 *
			 * Electron disables prompt outright — it returns null without showing anything, which is
			 * why the text tool did nothing at all. Typing in place is also the better version
			 * regardless: the caption is styled, sized and positioned as it will be, rather than
			 * described in a box somewhere else and then discovered.
			 *
			 * `preventDefault` is what makes it stay. A press on the canvas moves focus as its
			 * default action, and the field mounts into that press: it was focused by the effect
			 * below and blurred again by the same click a moment later, and `onBlur` commits an empty
			 * caption, which is to say it removes the field. The result was a box that flickered for
			 * one frame — indistinguishable from the tool doing nothing, which is how it was reported.
			 */
			event.preventDefault();
			// Commit what is open and start a new one where the click landed, rather than making the
			// second click of two do nothing but put the first one away.
			if (typing) commitText();
			setTyping({ at: point, value: "", width: Math.max(160, Math.round(width * 0.3)) });
			return;
		}

		// A badge is placed, not dragged; there is nothing to preview between press and release.
		if (tool === "step") {
			setHistory((h) => commit(h, [...current(h), { tool: "step", colour, points: [point] }]));
			setSelected(shapes.length);
			return;
		}

		event.currentTarget.setPointerCapture(event.pointerId);
		setDrawing({ tool: tool as Exclude<Tool, "select" | "text" | "step">, colour, points: [point] });
	};

	const move = (event: React.PointerEvent) => {
		const point = at(event);

		/*
		 * The cursor says whether there is anything here to pick up.
		 *
		 * Tested against the same `hitShape` the press uses, so what the cursor promises and what a
		 * press delivers cannot disagree — including the part where a hollow rectangle is grabbable
		 * on its edge and not in its middle. Only written when it changes, so moving across empty
		 * space does not re-render on every pointer event.
		 */
		if (!dragging) {
			const tol = pickTolerance(stroke, zoom);
			let over: "move" | "point" | "width" | null = null;
			if (chosen && selected !== null) {
				const grip = grips.find((g) => Math.hypot(g.at.x - point.x, g.at.y - point.y) <= tol * 1.8);
				if (grip) over = grip.index === WIDTH_HANDLE ? "width" : "point";
				else if (hitShape([chosen], point, tol) === 0) over = "move";
			}
			if (!over && tool === "select" && hitShape(shapes, point, tol) >= 0) over = "move";
			setHovering((was) => (was === over ? was : over));
		}

		if (dragging) {
			const dx = point.x - dragging.from.x;
			const dy = point.y - dragging.from.y;
			setDragging((held) => {
				if (!held) return held;
				const origin = shapes[held.index];
				if (!origin) return held;
				// Always from the original, so the drag does not accumulate rounding as it goes.
				const moving = held.handle === null ? moveShape(origin, dx, dy) : resizeShape(origin, held.handle, point);
				return { ...held, moving, moved: held.moved || Math.hypot(dx, dy) > 0.5 };
			});
			return;
		}

		if (!drawing) return;
		setDrawing((live) => {
			if (!live) return live;
			// Pen and mosaic accumulate; everything else is defined by its two ends.
			return live.tool === "pen" || live.tool === "mosaic"
				? { ...live, points: [...live.points, point] }
				: { ...live, points: [live.points[0]!, point] };
		});
	};

	const end = () => {
		if (dragging) {
			// One step in the history per move, and none at all for a drag that went nowhere.
			if (dragging.moved) {
				const { index, moving } = dragging;
				setHistory((h) => {
					const list = current(h);
					return index < list.length ? commit(h, list.map((s, i) => (i === index ? moving : s))) : h;
				});
			}
			setDragging(null);
			return;
		}

		if (!drawing) return;
		// A click with no drag leaves a one-point shape, which paints as nothing — drop it, except
		// for the pen and the mosaic, where a single dab is a legitimate mark.
		const keeps = drawing.tool === "pen" || drawing.tool === "mosaic";
		if (drawing.points.length > 1 || keeps) {
			setHistory((h) => commit(h, [...current(h), drawing]));
			// Handed back with its grips on, so the next thing you do to it is the adjustment rather
			// than the hunt for the tool that allows the adjustment.
			if (SELECT_ON_DRAW.has(drawing.tool)) setSelected(shapes.length);
		}
		setDrawing(null);
	};

	/*
	 * Grabbing while a mark is being moved, move while one is under the pointer, and the tool's own
	 * cursor otherwise. `grabbing` outranks `move` so the cursor does not flicker back the instant a
	 * fast drag outruns the hit test.
	 */
	const cursor = dragging
		? "cursor-grabbing"
		: hovering === "width"
			? "cursor-ew-resize"
			: hovering === "point"
				? "cursor-nwse-resize"
				: hovering === "move"
					? "cursor-move"
					: (CURSOR[tool] ?? "cursor-crosshair");

	// In display pixels. `chosen` already follows the drag, so the box travels with the mark rather
	// than staying where it was picked up.
	const box = chosen ? shapeBounds(chosen, stroke) : null;

	return (
		<div className="relative">
			<canvas
				ref={attach}
				onPointerDown={start}
				onPointerMove={move}
				onPointerUp={end}
				onPointerCancel={end}
				onPointerLeave={() => setHovering(null)}
				onDoubleClick={(event) => {
					// Zooming is the double-click on the stage below; this one belongs to the mark.
					event.stopPropagation();
					if (tool !== "select") return;
					const index = hitShape(shapes, at(event), pickTolerance(stroke, zoom));
					if (index >= 0) editText(index);
				}}
				className={`${STAGE_FIT} block rounded-xl bg-white ${cursor}`}
				style={{ touchAction: "none" }}
			/>

			{box && (
				/*
				 * A box around what is selected, and a button to remove it.
				 *
				 * `pointer-events-none` on the frame: it lies over the mark, and a frame that swallowed
				 * the press would make the thing it is pointing at the one thing you cannot grab.
				 */
				<div
					className="pointer-events-none absolute"
					style={{
						left: box.x * display,
						top: box.y * display,
						width: box.w * display,
						height: box.h * display,
					}}
				>
					<span className="absolute inset-0 rounded-[3px] border border-sky-400 border-dashed bg-sky-400/10" />
					<button
						type="button"
						data-ly-tip="删除这个标注 ⌫"
						data-ly-tip-side="top"
						aria-label="删除选中的标注"
						onPointerDown={(event) => event.stopPropagation()}
						onClick={annotator.removeSelected}
						className="pointer-events-auto -top-3 -right-3 absolute flex h-6 w-6 items-center justify-center rounded-full bg-[#1c1c1e] text-white/90 shadow-md transition-[transform,background-color] duration-[var(--ly-t-quick)] hover:scale-110 hover:bg-red-500 hover:text-white"
					>
						<Trash2 size={12} strokeWidth={2} />
					</button>
				</div>
			)}

			{/*
			 * The grips, drawn but not clickable.
			 *
			 * Hit testing for them happens on the canvas, against the same coordinates the drag will
			 * use. Making them real targets would mean a second copy of that logic living in the DOM,
			 * and two copies of a hit test is one more than can be kept in agreement.
			 */}
			{chosen &&
				grips.map((grip) => (
					<span
						key={grip.index}
						className="pointer-events-none absolute h-2.5 w-2.5 rounded-full border-2 border-white bg-sky-500 shadow-sm"
						style={{
							left: grip.at.x * display - 5,
							top: grip.at.y * display - 5,
						}}
					/>
				))}

			{typing && (
				/*
				 * The field is the preview.
				 *
				 * Every value below is the display-space image of what `paint` will do with the same
				 * caption: the same font, the same line height, the same padding, the same colour, the
				 * same backdrop, wrapping at the same column. The earlier version made the field
				 * transparent and painted a preview underneath it, which is two implementations of one
				 * appearance and looked it — a grey box with a dashed border, nothing like the result.
				 */
				<div
					className="absolute"
					style={{ left: typing.at.x * display, top: typing.at.y * display, width: typing.width * display }}
					onPointerDown={(event) => event.stopPropagation()}
				>
					{/*
					 * A border you can pick the caption up by, while still typing in it.
					 *
					 * It sits under the field and eight points wider on every side, so the only part of
					 * it that can be pressed is the margin outside the text — the middle still puts the
					 * caret where you clicked. Without it, moving a caption you were part-way through
					 * writing meant committing it, switching tools, dragging, and double-clicking back
					 * in, which is four actions to answer "not there, here".
					 */}
					<span
						aria-hidden
						onPointerDown={(event) => {
							event.preventDefault();
							event.stopPropagation();
							event.currentTarget.setPointerCapture(event.pointerId);
							carrying.current = { x: event.clientX, y: event.clientY, from: typing.at, scale: display || 1 };
						}}
						onPointerMove={(event) => {
							const held = carrying.current;
							if (!held) return;
							setTyping((entry) =>
								entry
									? {
											...entry,
											at: {
												x: held.from.x + (event.clientX - held.x) / held.scale,
												y: held.from.y + (event.clientY - held.y) / held.scale,
											},
										}
									: entry,
							);
						}}
						onPointerUp={() => {
							carrying.current = null;
						}}
						className="-inset-2 absolute cursor-move rounded-lg"
					/>
					<textarea
						ref={field}
						value={typing.value}
						onChange={(event) => setTyping((entry) => (entry ? { ...entry, value: event.target.value } : entry))}
						onBlur={commitText}
						onKeyDown={(event) => {
							// Stopped here so the viewer's Escape does not close the whole overlay when all
							// that was wanted was to abandon a caption.
							event.stopPropagation();
							// Enter commits; shift-enter is how you ask for the second line.
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								commitText();
							}
							if (event.key === "Escape") setTyping(null);
						}}
						placeholder="输入文字"
						rows={1}
						spellCheck={false}
						className="relative block w-full resize-none overflow-hidden border-0 bg-transparent outline-none placeholder:text-current placeholder:opacity-40"
						style={{
							font: fontOf(typeSize * display),
							lineHeight: LINE,
							padding: `${typeSize * PAD * display}px`,
							color: colour,
							background: backdrop ?? "transparent",
							borderRadius: `${typeSize * 0.2 * display}px`,
							caretColor: colour,
							// Same breaking rule as the canvas: anywhere for CJK, at spaces for latin.
							wordBreak: "break-word",
							whiteSpace: "pre-wrap",
							/*
							 * The same light outline the paint adds when there is no backdrop, and for the
							 * same reason. Without it here the typed text is a shade more saturated than
							 * the committed text, which is a difference you only notice at the moment the
							 * field disappears and the caption seems to change.
							 *
							 * `paint-order` puts the stroke under the fill, which is what drawing
							 * `strokeText` before `fillText` does on the canvas.
							 */
							WebkitTextStroke: backdrop
								? undefined
								: `${Math.max(2, typeSize / 9) * display}px rgba(255,255,255,0.92)`,
							paintOrder: "stroke fill",
						}}
					/>
					{/* A dotted outline that is not part of the caption, only of editing it. */}
					<span className="pointer-events-none absolute inset-0 rounded-md border border-sky-400/70 border-dashed" />
					<button
						type="button"
						aria-label="调整文字宽度"
						data-ly-tip="拖动调整宽度"
						data-ly-tip-side="top"
						onPointerDown={(event) => {
							event.preventDefault();
							event.stopPropagation();
							event.currentTarget.setPointerCapture(event.pointerId);
							sizing.current = { x: event.clientX, from: typing.width, scale: display || 1 };
						}}
						onPointerMove={(event) => {
							const held = sizing.current;
							if (!held) return;
							const next = held.from + (event.clientX - held.x) / held.scale;
							setTyping((entry) =>
								entry ? { ...entry, width: Math.max(typeSize * 2, Math.min(next, width)) } : entry,
							);
						}}
						onPointerUp={() => {
							sizing.current = null;
						}}
						className="-right-1.5 -bottom-1.5 absolute h-3.5 w-3.5 cursor-ew-resize rounded-full border border-white bg-sky-400 shadow-sm transition-transform duration-[var(--ly-t-quick)] hover:scale-125"
					/>
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// The toolbar
// ---------------------------------------------------------------------------

const TOOLS: [Tool, typeof Pencil, string][] = [
	["select", MousePointer2, "选择 / 移动"],
	["pen", Pencil, "画笔"],
	["arrow", ArrowUpRight, "箭头"],
	["line", Minus, "直线"],
	["rect", Square, "矩形"],
	["ellipse", Circle, "圆形"],
	["step", ListOrdered, "步骤标号"],
	["text", Type, "文字"],
	["mosaic", Grid2x2, "马赛克"],
];

const COLOUR_NAMES: Record<string, string> = {
	"#ef4444": "红色",
	"#3b82f6": "蓝色",
	"#22c55e": "绿色",
	"#eab308": "黄色",
	"#111827": "黑色",
};

export function AnnotateToolbar({
	annotator,
	onCancel,
	onSave,
	canReplace,
}: {
	annotator: Annotator;
	onCancel: () => void;
	onSave: () => void;
	/** Whether saving can replace the original, or only produce a copy. */
	canReplace: boolean;
}) {
	const [shown, setShown] = useState(false);
	useEffect(() => {
		// One frame late, so the transition has a start state to move away from.
		const id = requestAnimationFrame(() => setShown(true));
		return () => cancelAnimationFrame(id);
	}, []);

	// Undo, redo and delete from the keyboard, which is where anyone drawing reaches first.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			// Never while typing a caption: there, ⌘Z belongs to the field and backspace is a
			// backspace. A shortcut that deletes the mark you are in the middle of writing is worse
			// than no shortcut.
			if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;

			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
				event.preventDefault();
				if (event.shiftKey) annotator.redo();
				else annotator.undo();
				return;
			}

			if ((event.key === "Backspace" || event.key === "Delete") && annotator.selected !== null) {
				// Backspace is the browser's "go back" on some setups; taking it is the point.
				event.preventDefault();
				annotator.removeSelected();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [annotator]);

	return (
		<div
			/*
			 * Fixed to the window, at a size that does not depend on the picture.
			 *
			 * The toolbar used to sit under the image in a column, which meant the image had to give up
			 * height to make room for it — entering edit mode visibly shrank the picture. Floating it
			 * means the picture is exactly the same size in both modes, and the bar stays legible
			 * against whatever is behind it through its own background rather than by pushing things
			 * out of the way.
			 */
			className="pointer-events-auto fixed bottom-6 left-1/2 z-[120] flex items-center gap-1 rounded-2xl border border-white/12 bg-[#1c1c1e]/92 px-2 py-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.45)] backdrop-blur-xl transition-[opacity,transform] duration-[var(--ly-t-base)] ease-out"
			style={{ opacity: shown ? 1 : 0, transform: `translateX(-50%) translateY(${shown ? 0 : 10}px)` }}
		>
			{TOOLS.map(([id, Icon, label]) => (
				<ToolButton key={id} label={label} active={annotator.tool === id} onClick={() => annotator.setTool(id)}>
					<Icon size={14} strokeWidth={1.9} />
				</ToolButton>
			))}

			<Divider />

			{COLOURS.map((value) => (
				<button
					key={value}
					type="button"
					data-ly-tip={COLOUR_NAMES[value] ?? value}
					data-ly-tip-side="top"
					aria-label={COLOUR_NAMES[value] ?? value}
					aria-pressed={annotator.colour === value}
					onClick={() => annotator.setColour(value)}
					style={{ background: value }}
					className={`h-[18px] w-[18px] rounded-full transition-transform duration-[var(--ly-t-quick)] ${
						annotator.colour === value
							? "scale-115 ring-2 ring-white/80 ring-offset-2 ring-offset-[#1c1c1e]"
							: "opacity-80 hover:scale-110 hover:opacity-100"
					}`}
				/>
			))}

			{/*
			 * Only while the text tool is up.
			 *
			 * A backdrop is a property of a caption and of nothing else, and a bar that shows every
			 * control for every tool is a bar you have to read. It grows in rather than appearing, so
			 * the buttons beside it are seen to move rather than found to have moved.
			 */}
			{annotator.tool === "text" && (
				<>
					<Divider />
					<div className="flex animate-[ly-tool-in_var(--ly-t-base)_ease-out] items-center gap-1">
						{BACKDROPS.map(([value, label]) => (
							<button
								key={label}
								type="button"
								data-ly-tip={`文字底色：${label}`}
								data-ly-tip-side="top"
								aria-label={`文字底色 ${label}`}
								aria-pressed={annotator.backdrop === value}
								onClick={() => annotator.setBackdrop(value)}
								style={value ? { background: value } : undefined}
								className={`h-[18px] w-[18px] rounded-[5px] transition-transform duration-[var(--ly-t-quick)] ${
									value ? "" : "ly-checker-xs"
								} ${
									annotator.backdrop === value
										? "scale-115 ring-2 ring-white/80 ring-offset-2 ring-offset-[#1c1c1e]"
										: "opacity-80 hover:scale-110 hover:opacity-100"
								}`}
							/>
						))}
					</div>
				</>
			)}

			<Divider />

			<ToolButton label="撤销 ⌘Z" disabled={!annotator.canUndo} onClick={annotator.undo}>
				<Undo2 size={14} strokeWidth={1.9} />
			</ToolButton>
			<ToolButton label="重做 ⇧⌘Z" disabled={!annotator.canRedo} onClick={annotator.redo}>
				<Redo2 size={14} strokeWidth={1.9} />
			</ToolButton>
			<ToolButton label="清空" disabled={!annotator.dirty} onClick={annotator.clear}>
				<Trash2 size={14} strokeWidth={1.9} />
			</ToolButton>

			<Divider />

			<button
				type="button"
				data-ly-tip="退出标注"
				data-ly-tip-side="top"
				aria-label="退出标注"
				onClick={onCancel}
				className="flex h-7 items-center rounded-lg px-2.5 text-white/65 transition-colors duration-[var(--ly-t-quick)] hover:text-white"
			>
				<X size={13} strokeWidth={2} />
			</button>
			<button
				type="button"
				data-ly-tip={canReplace ? "保存并替换原图" : "导出一份带标注的副本"}
				data-ly-tip-side="top"
				disabled={!annotator.dirty}
				onClick={onSave}
				// `whitespace-nowrap` because the label is four characters and the button is sized by
				// its padding: without it "保存副本" wrapped to two lines and took the whole bar's
				// height with it.
				className="flex h-7 items-center whitespace-nowrap rounded-lg bg-white px-3 text-detail font-medium text-[#1c1c1e] transition-opacity duration-[var(--ly-t-quick)] hover:opacity-90 disabled:opacity-35"
			>
				{canReplace ? "保存" : "保存副本"}
			</button>
		</div>
	);
}

const Divider = () => <span className="mx-1 h-4 w-px bg-white/15" />;

function ToolButton({
	label,
	active,
	disabled,
	onClick,
	children,
}: {
	label: string;
	active?: boolean;
	disabled?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			data-ly-tip={label}
			// Above: the bar sits at the bottom of the window, so a bubble below it would be off screen
			// and get flipped anyway. Saying so directly avoids the flip.
			data-ly-tip-side="top"
			aria-label={label}
			aria-pressed={active}
			disabled={disabled}
			onClick={onClick}
			className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors duration-[var(--ly-t-quick)] disabled:opacity-30 ${
				active ? "bg-white text-[#1c1c1e]" : "text-white/65 hover:bg-white/12 hover:text-white"
			}`}
		>
			{children}
		</button>
	);
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/** Blit one averaged pixel per covered cell, at block size, with smoothing off. */
function paintMosaic(
	ctx: CanvasRenderingContext2D,
	shape: Shape,
	source: HTMLCanvasElement | null,
	block: number,
	brush: number,
) {
	if (!source) return;
	const smoothing = ctx.imageSmoothingEnabled;
	ctx.imageSmoothingEnabled = false;
	for (const cell of mosaicCells(shape.points, brush, block)) {
		const [x, y] = cell.split(",").map(Number) as [number, number];
		if (x < 0 || y < 0) continue;
		ctx.drawImage(source, x / block, y / block, 1, 1, x, y, block, block);
	}
	ctx.imageSmoothingEnabled = smoothing;
}

/**
 * The top of line `i`'s glyphs.
 *
 * Half the leading sits above the text and half below, which is what a line box does and therefore
 * what the field does. Getting this wrong shifts the painted caption a few pixels off the one that
 * was typed — small, and visible the moment the field disappears.
 */
const baseline = (top: number, pad: number, i: number, step: number, size: number) =>
	top + pad + i * step + (step - size) / 2;

function paint(ctx: CanvasRenderingContext2D, shape: Shape, stroke: number, step: number) {
	ctx.strokeStyle = shape.colour;
	ctx.fillStyle = shape.colour;
	ctx.lineWidth = stroke;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";

	const first = shape.points[0];
	const last = shape.points[shape.points.length - 1];
	if (!first || !last) return;

	if (shape.tool === "text") {
		const size = shape.size ?? stroke * TEXT_SCALE;
		const pad = size * PAD;
		ctx.font = fontOf(size);
		ctx.textBaseline = "top";

		// The same column the field wrapped at, so the lines break in the same places.
		const column = (shape.width ?? Number.POSITIVE_INFINITY) - pad * 2;
		const lines = wrapText((line) => ctx.measureText(line).width, shape.text ?? "", column);
		const step = size * LINE;

		if (shape.background) {
			ctx.fillStyle = shape.background;
			const box = shape.width ?? Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
			const height = lines.length * step + pad * 2;
			ctx.beginPath();
			ctx.roundRect(first.x, first.y, box, height, size * 0.2);
			ctx.fill();
		} else {
			// Nothing behind it, so the text carries its own contrast: a light outline under the fill
			// keeps a red caption readable over a red screenshot.
			ctx.strokeStyle = "rgba(255,255,255,0.92)";
			ctx.lineWidth = Math.max(2, size / 9);
			ctx.lineJoin = "round";
			lines.forEach((line, i) => ctx.strokeText(line, first.x + pad, baseline(first.y, pad, i, step, size)));
		}

		ctx.fillStyle = shape.colour;
		lines.forEach((line, i) => ctx.fillText(line, first.x + pad, baseline(first.y, pad, i, step, size)));
		return;
	}

	if (shape.tool === "step") {
		// A filled disc with the number in it, sized off the stroke like everything else. Centred on
		// the click rather than starting there: a badge marks a spot, it does not begin at one.
		const radius = Math.max(12, stroke * 4.5);
		ctx.beginPath();
		ctx.arc(first.x, first.y, radius, 0, Math.PI * 2);
		ctx.fill();
		ctx.strokeStyle = "rgba(255,255,255,0.95)";
		ctx.lineWidth = Math.max(2, radius / 7);
		ctx.stroke();

		ctx.fillStyle = "#ffffff";
		ctx.font = `600 ${Math.round(radius * 1.15)}px -apple-system, system-ui, sans-serif`;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(String(step), first.x, first.y + radius * 0.04);
		ctx.textAlign = "start";
		ctx.textBaseline = "alphabetic";
		return;
	}

	if (shape.tool === "arrow") {
		const head = Math.max(10, stroke * 4);
		const angle = Math.atan2(last.y - first.y, last.x - first.x);
		// The shaft stops short of the tip, so the line does not show through the notch of the head.
		const shaft = Math.max(0, Math.hypot(last.x - first.x, last.y - first.y) - head * 0.72);
		ctx.beginPath();
		ctx.moveTo(first.x, first.y);
		ctx.lineTo(first.x + Math.cos(angle) * shaft, first.y + Math.sin(angle) * shaft);
		ctx.stroke();

		// A solid triangle rather than two strokes: at any size it reads as one arrowhead.
		const wing = Math.PI / 7;
		ctx.beginPath();
		ctx.moveTo(last.x, last.y);
		ctx.lineTo(last.x - Math.cos(angle - wing) * head, last.y - Math.sin(angle - wing) * head);
		ctx.lineTo(last.x - Math.cos(angle + wing) * head, last.y - Math.sin(angle + wing) * head);
		ctx.closePath();
		ctx.fill();
		return;
	}

	ctx.beginPath();
	if (shape.tool === "pen") {
		ctx.moveTo(first.x, first.y);
		for (const point of shape.points.slice(1)) ctx.lineTo(point.x, point.y);
		// A single click leaves a dot rather than nothing.
		if (shape.points.length === 1) ctx.lineTo(first.x + 0.01, first.y);
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
