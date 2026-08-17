/**
 * The arithmetic behind annotating an image: what a mark is, what undo means, how the step numbers
 * are counted, which cells a mosaic covers, and where the picture goes when you zoom into it.
 *
 * Kept apart from the component because all of them can be wrong in ways a screenshot will not show.
 * A zoom that does not hold its anchor drifts a little on every notch of the wheel; step numbers
 * that are stored rather than counted go 1, 2, 4 the moment you undo the third one. Neither is
 * visible in a still image, and both are ordinary functions with ordinary answers, so they are
 * tested as such.
 *
 * Every coordinate here is in the image's *natural* pixels. The canvas is opened at that size and
 * scaled down by CSS, so a mark on a 3000px screenshot is stored at 3000px and stays as sharp as the
 * screenshot when it is saved.
 */

export type Tool = "pen" | "arrow" | "line" | "rect" | "ellipse" | "step" | "text" | "mosaic";

export interface Point {
	x: number;
	y: number;
}

export interface Shape {
	tool: Tool;
	colour: string;
	/** Pen and mosaic keep every point; the rest are defined by where the drag started and ended. */
	points: Point[];
	text?: string;
	/** Type size in natural pixels, so text scales with the image like every other mark. */
	size?: number;
	/** Text only: the column width it wraps at, in natural pixels. */
	width?: number;
	/** Text only: a CSS colour behind the text, or undefined for none. */
	background?: string;
}

// ---------------------------------------------------------------------------
// Text layout
// ---------------------------------------------------------------------------

/** The smallest run that will not be broken across lines. */
function segments(text: string): string[] {
	const out: string[] = [];
	let latin = "";
	for (const ch of text) {
		// CJK breaks anywhere, which is how CJK is set; Latin breaks at spaces, which is how it reads.
		if (/[　-〿぀-ヿ一-鿿＀-￯]/.test(ch)) {
			if (latin) {
				out.push(latin);
				latin = "";
			}
			out.push(ch);
		} else if (ch === " ") {
			out.push(`${latin} `);
			latin = "";
		} else {
			latin += ch;
		}
	}
	if (latin) out.push(latin);
	return out;
}

/**
 * Break text into lines that fit a column, honouring the newlines already in it.
 *
 * A canvas has no line breaking of its own — `fillText` draws one line however long it is and runs
 * off the edge of the picture, which is what the caption did. Measurement is passed in rather than
 * taken from a context so the rule can be tested without a DOM, and so the same function serves both
 * the live field and the paint.
 */
export function wrapText(measure: (line: string) => number, text: string, maxWidth: number): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		let line = "";
		for (const run of segments(paragraph)) {
			const next = line + run;
			if (line !== "" && measure(next) > maxWidth) {
				lines.push(line);
				// The space that caused the break belongs to neither line.
				line = run.trimStart() === "" ? "" : run.replace(/^ +/, "");
			} else {
				line = next;
			}
		}
		lines.push(line);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * Undo and redo over one list of steps with a cursor into it, rather than two stacks.
 *
 * The two-stack version has to move entries between them on every operation and gets the boundaries
 * wrong in exactly one place: committing while some redo is available has to discard the redo, and
 * with two stacks that is a separate thing to remember. Here it falls out of the array slice.
 */
export interface History {
	steps: Shape[][];
	cursor: number;
}

/** Enough to undo an afternoon, bounded so a long session does not hold every state it ever had. */
export const HISTORY_LIMIT = 100;

export const emptyHistory = (): History => ({ steps: [[]], cursor: 0 });

export const current = (history: History): Shape[] => history.steps[history.cursor] ?? [];

export const canUndo = (history: History): boolean => history.cursor > 0;
export const canRedo = (history: History): boolean => history.cursor < history.steps.length - 1;

export const undo = (history: History): History =>
	canUndo(history) ? { ...history, cursor: history.cursor - 1 } : history;

export const redo = (history: History): History =>
	canRedo(history) ? { ...history, cursor: history.cursor + 1 } : history;

/**
 * Record a new state, dropping anything that was ahead of the cursor.
 *
 * Drawing after undoing abandons the undone branch — the alternative is a tree, and a tree is a
 * thing the user then has to navigate. Nobody has ever wanted that from a screenshot annotator.
 */
export function commit(history: History, shapes: Shape[]): History {
	const steps = [...history.steps.slice(0, history.cursor + 1), shapes];
	const excess = steps.length - HISTORY_LIMIT;
	if (excess <= 0) return { steps, cursor: steps.length - 1 };
	// Oldest steps fall off the front; the cursor still points at the newest.
	const kept = steps.slice(excess);
	return { steps: kept, cursor: kept.length - 1 };
}

// ---------------------------------------------------------------------------
// Step numbers
// ---------------------------------------------------------------------------

/**
 * What number a step badge shows: its position among the step badges, counted at paint time.
 *
 * Counted rather than stored, so undoing the second of four renumbers the rest instead of leaving
 * 1, 3, 4. The badge is a description of the order, and the order is a property of the list.
 */
export function stepNumber(shapes: Shape[], index: number): number {
	let n = 0;
	for (let i = 0; i <= index && i < shapes.length; i++) {
		if (shapes[i]?.tool === "step") n++;
	}
	return n;
}

// ---------------------------------------------------------------------------
// Mosaic
// ---------------------------------------------------------------------------

/** Mosaic block size for an image of this width — coarse enough to actually obscure a face or a token. */
export function mosaicBlock(width: number): number {
	return Math.max(8, Math.round(width / 90));
}

/** How wide the mosaic brush paints, in natural pixels. */
export function mosaicBrush(width: number): number {
	return Math.max(16, Math.round(width / 28));
}

/**
 * Which grid cells a mosaic stroke covers, as `x,y` of each cell's top-left corner.
 *
 * Snapped to a grid rather than painted freely, for two reasons. Blocks that line up read as
 * deliberate redaction, where blur that follows the cursor reads as a smudge. And a grid is
 * idempotent: going over the same spot twice covers the same cells, so a nervous scribble does not
 * end up darker than a confident one.
 */
export function mosaicCells(points: Point[], brush: number, block: number): string[] {
	const cells = new Set<string>();
	const radius = brush / 2;
	for (const point of points) {
		const left = Math.floor((point.x - radius) / block) * block;
		const top = Math.floor((point.y - radius) / block) * block;
		for (let x = left; x <= point.x + radius; x += block) {
			for (let y = top; y <= point.y + radius; y += block) {
				// The cell's centre inside the brush, so the stroke has a round end rather than a
				// square one that lags behind the cursor at the corners.
				if (Math.hypot(x + block / 2 - point.x, y + block / 2 - point.y) <= radius + block / 2) {
					cells.add(`${x},${y}`);
				}
			}
		}
	}
	return [...cells];
}

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 8;
/** One press of the zoom buttons; the wheel uses a fraction of it per notch. */
export const ZOOM_STEP = 1.25;

export const clampZoom = (zoom: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

/**
 * Zoom about a point on the screen, keeping whatever is under that point under it.
 *
 * The stage is transformed as `translate(offset) scale(zoom)` about its own centre, so a point at
 * screen offset `v` from that centre sits at content offset `(v - offset) / zoom`. Holding it still
 * across a change of zoom is that identity solved for the new offset — which is the difference
 * between zooming into what you are looking at and zooming into the middle and then hunting for it.
 */
export function zoomAt(
	from: number,
	to: number,
	offset: Point,
	anchor: Point,
	centre: Point,
): { zoom: number; offset: Point } {
	const zoom = clampZoom(to);
	const ratio = zoom / from;
	const vx = anchor.x - centre.x;
	const vy = anchor.y - centre.y;
	return {
		zoom,
		offset: { x: vx - (vx - offset.x) * ratio, y: vy - (vy - offset.y) * ratio },
	};
}
