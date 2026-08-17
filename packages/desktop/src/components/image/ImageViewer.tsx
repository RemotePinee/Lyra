/**
 * The image, full size, arriving from wherever you clicked it.
 *
 * Two transforms, on two elements, for two unrelated jobs.
 *
 * The outer one is the flight. It is FLIP and it has to be, because the two states have different
 * sizes and there is no single property that gets from one to the other honestly. The final layout
 * is computed first — centred, contained within the window — and then the *first* frame is expressed
 * as a transform that lands the image exactly on the thumbnail it came from. One frame later the
 * transform is removed and the browser interpolates. Nothing is ever laid out at an intermediate
 * size, so a large picture costs the same as a small one and neither reflows on the way.
 *
 * The inner one is zoom and pan. It is a separate element because FLIP writes `style.transform`
 * directly and the two would otherwise overwrite each other. Keeping them apart also means the FLIP
 * measurement is of the settled layout box, which a child's transform does not affect — so zooming
 * in and then closing still flies back to the right thumbnail.
 *
 * Closing runs the same path backwards, and only unmounts when it finishes — an overlay that
 * disappears on the click and animates nothing is the thing this replaced.
 */

import { ChevronLeft, ChevronRight, Download, Maximize2, Minus, Pencil, Plus, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { clampZoom, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, zoomAt, type Point } from "./annotate.ts";
import { AnnotateCanvas, AnnotateToolbar, STAGE_FIT, useAnnotator } from "./Annotator.tsx";
import { closeViewer, stepViewer, useViewer } from "./viewer-store.ts";

/** Matches `--ly-t-base`; kept as a number because the unmount has to be timed against it. */
const DURATION = 220;

const CENTRED: Point = { x: 0, y: 0 };

export function ImageViewer() {
	const state = useViewer();
	const [leaving, setLeaving] = useState(false);
	const [editing, setEditing] = useState(false);
	const figure = useRef<HTMLDivElement>(null);
	const origin = useRef<DOMRect | null>(null);

	// Held across the closing animation, so the image does not vanish before it has shrunk.
	const [held, setHeld] = useState<ReturnType<typeof useViewer>>(null);
	const shown = state ?? held;
	const image = shown?.images[shown.index] ?? null;

	/*
	 * Zoom and offset are one piece of state, not two.
	 *
	 * They only ever change together — every zoom implies the offset that keeps the anchor still —
	 * and holding them apart invites the update that reads one while setting the other. It was
	 * written that way first: `setOffset(previous => { setZoom(...); return ... })`, which calls a
	 * setter from inside an updater. An updater must be a pure function of the state, because React
	 * runs it more than once per commit. As one value it cannot be written that way, and `zoomAt`
	 * already returns exactly this shape.
	 */
	const [view, setView] = useState<{ zoom: number; offset: Point }>({ zoom: 1, offset: CENTRED });
	const { zoom, offset } = view;
	const [panning, setPanning] = useState(false);
	const [spacing, setSpacing] = useState(false);
	const grab = useRef<{ x: number; y: number; from: Point } | null>(null);

	/*
	 * Decoded as soon as the picture is on screen, not when 标注 is pressed.
	 *
	 * Deferring it saved a decode and cost a flash: the canvas mounts before the source has loaded,
	 * and a canvas with no width attribute is 300×150, so pressing 标注 replaced the picture with a
	 * small white box for as long as the decode took. Preparing it while it is merely being looked at
	 * means the natural size is already known when the canvas appears and the swap is invisible.
	 *
	 * The cost is one decode of an image the browser has already decoded for the `<img>`, and a
	 * mosaic source a ninetieth of its width.
	 */
	const annotator = useAnnotator(image?.src ?? "");

	const resetView = useCallback(() => setView({ zoom: 1, offset: CENTRED }), []);

	useLayoutEffect(() => {
		if (!state) return;
		setHeld(state);
		setLeaving(false);
		if (state.origin) origin.current = state.origin;
	}, [state]);

	// A different picture is a different thing to be looking at; it arrives at its own size.
	const src = image?.src;
	useEffect(() => {
		resetView();
	}, [src, resetView]);

	/*
	 * The flight, driven straight at the DOM rather than through React.
	 *
	 * FLIP measures the *final* layout and then expresses the start as a transform away from it. The
	 * measurement therefore has to happen on a frame where no transform is applied — and that is
	 * exactly what a rendered `transform` in JSX cannot guarantee, because the next render measures
	 * an element that is already transformed. Doing that produced a scale of 1 on the second pass
	 * (the box had shrunk to match the thumbnail, so they agreed) and the picture stayed thumbnail
	 * sized for ever, which is the bug this replaced.
	 *
	 * Setting `style.transform` here instead means the element is only ever measured in its settled
	 * state. Reading `offsetWidth` between the two writes forces the browser to accept the start
	 * position as a real style before the transition to the end position begins; without it the two
	 * writes coalesce and nothing animates.
	 */
	useLayoutEffect(() => {
		const el = figure.current;
		const from = origin.current;
		if (!el || !shown || leaving) return;
		if (!from) {
			// Arrived without a source rectangle — an arrow key rather than a click. Nothing to fly
			// from, so it simply appears.
			el.style.transform = "";
			return;
		}
		const to = el.getBoundingClientRect();
		if (to.width === 0 || to.height === 0) return;

		const dx = from.left + from.width / 2 - (to.left + to.width / 2);
		const dy = from.top + from.height / 2 - (to.top + to.height / 2);
		const sx = Math.max(from.width / to.width, 0.01);
		const sy = Math.max(from.height / to.height, 0.01);

		el.style.transition = "none";
		el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
		void el.offsetWidth;
		el.style.transition = "";
		el.style.transform = "";
	}, [shown, leaving]);

	const dismiss = useCallback(() => {
		if (leaving) return;
		setEditing(false);
		setLeaving(true);
		// Unzoomed on the way out, so the picture shrinks back to the thumbnail along one path rather
		// than flying from a size the layout box knows nothing about.
		resetView();

		const el = figure.current;
		const from = origin.current;
		if (el && from) {
			const to = el.getBoundingClientRect();
			if (to.width > 0) {
				const dx = from.left + from.width / 2 - (to.left + to.width / 2);
				const dy = from.top + from.height / 2 - (to.top + to.height / 2);
				el.style.transform = `translate(${dx}px, ${dy}px) scale(${Math.max(from.width / to.width, 0.01)}, ${Math.max(from.height / to.height, 0.01)})`;
			}
			el.style.opacity = "0";
		}

		window.setTimeout(() => {
			setHeld(null);
			origin.current = null;
			if (el) {
				el.style.transform = "";
				el.style.opacity = "";
			}
			closeViewer();
		}, DURATION);
	}, [leaving, resetView]);

	/**
	 * Zoom about a point on the screen, holding whatever is under it.
	 *
	 * The measurement happens out here and the arithmetic happens in the updater, which means this
	 * depends on nothing and a wheel spun faster than React renders still composes correctly —
	 * each notch sees the state the one before it produced rather than the one it was declared with.
	 */
	const zoomTo = useCallback((next: number, anchor?: Point) => {
		const box = figure.current?.getBoundingClientRect();
		if (!box) {
			setView((v) => ({ ...v, zoom: clampZoom(next) }));
			return;
		}
		const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
		setView((v) => zoomAt(v.zoom, next, v.offset, anchor ?? centre, centre));
	}, []);

	useEffect(() => {
		if (!shown) return;
		const typingIn = (node: EventTarget | null) =>
			node instanceof HTMLElement && (node.tagName === "INPUT" || node.tagName === "TEXTAREA");

		const onKey = (event: KeyboardEvent) => {
			if (typingIn(event.target)) return;
			// Space is held to pan, so it must not also scroll or press whatever has focus.
			if (event.code === "Space") {
				event.preventDefault();
				setSpacing(true);
				return;
			}
			if (event.key === "Escape") dismiss();
			if (editing) return;
			if (event.key === "ArrowLeft") stepViewer(-1);
			if (event.key === "ArrowRight") stepViewer(1);
		};
		const onUp = (event: KeyboardEvent) => {
			if (event.code === "Space") setSpacing(false);
		};
		// Losing the window while holding space would otherwise leave it stuck down.
		const release = () => setSpacing(false);

		window.addEventListener("keydown", onKey);
		window.addEventListener("keyup", onUp);
		window.addEventListener("blur", release);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("keyup", onUp);
			window.removeEventListener("blur", release);
		};
	}, [shown, editing, dismiss]);

	if (!shown || !image) return null;

	const open = !leaving;
	// Dragging pans only when the drag cannot mean anything else: while not editing, or while space
	// is held. Otherwise a drag on the canvas is a stroke, which is what it should be.
	const canPan = spacing || (!editing && zoom > 1);

	const startPan = (event: React.PointerEvent) => {
		if (!canPan || event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		grab.current = { x: event.clientX, y: event.clientY, from: offset };
		setPanning(true);
		event.currentTarget.setPointerCapture(event.pointerId);
	};

	const movePan = (event: React.PointerEvent) => {
		const from = grab.current;
		if (!from) return;
		setView((v) => ({
			...v,
			offset: { x: from.from.x + (event.clientX - from.x), y: from.from.y + (event.clientY - from.y) },
		}));
	};

	const endPan = () => {
		grab.current = null;
		setPanning(false);
	};

	return createPortal(
		<div
			role="dialog"
			aria-modal
			aria-label="图片预览"
			/*
			 * `no-drag` over the whole overlay.
			 *
			 * The window reserves its top 44px as a drag region, and a drag region hands the press to
			 * the window manager before the page ever sees it. This overlay covers the window, so its
			 * controls sit in that strip — and they were drawn, were on top, passed every hit test the
			 * page can run, and did nothing at all: pressing one moved the window.
			 *
			 * The whole layer rather than each button, because while a modal is up there is nothing
			 * behind it to drag the window by. Dragging resumes the moment it closes.
			 */
			className="no-drag fixed inset-0 z-[100] flex items-center justify-center overflow-hidden"
			onWheel={(event) => {
				// Trackpad pinch arrives as a wheel with ctrlKey held; both gestures mean the same
				// thing here, at different sensitivities.
				const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0022));
				zoomTo(zoom * factor, { x: event.clientX, y: event.clientY });
			}}
		>
			{/*
			 * The backdrop is a button rather than a div with a handler on it: dismissing by clicking
			 * away is a real action, and giving it a real control is what makes it reachable by
			 * keyboard and announced as something that can be pressed.
			 */}
			<button
				type="button"
				aria-label="关闭预览"
				tabIndex={-1}
				onClick={dismiss}
				className="absolute inset-0 cursor-default bg-black/72 transition-opacity duration-[var(--ly-t-base)] ease-out"
				style={{ opacity: open ? 1 : 0 }}
			/>

			<div
				ref={figure}
				className="relative transition-[transform,opacity] duration-[var(--ly-t-base)] ease-out"
				style={{ transformOrigin: "center" }}
			>
				<div
					onPointerDown={startPan}
					onPointerMove={movePan}
					onPointerUp={endPan}
					onPointerCancel={endPan}
					onDoubleClick={() => (zoom === 1 ? zoomTo(2) : resetView())}
					className={canPan ? (panning ? "cursor-grabbing" : "cursor-grab") : undefined}
					style={{
						transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
						transformOrigin: "center",
						// Not while dragging: a transition on a per-frame update is a picture that
						// arrives where the pointer was a moment ago.
						transition: panning ? "none" : `transform ${DURATION}ms ease-out`,
					}}
				>
					{editing ? (
						<AnnotateCanvas annotator={annotator} />
					) : (
						<img
							src={image.src}
							alt={image.alt ?? ""}
							draggable={false}
							/*
							 * The same fit as the canvas, from the same constant. These two used to differ
							 * — 86vh for the picture, 74vh once the toolbar was laid out under it — so
							 * pressing 标注 visibly shrank the image before anything had been drawn.
							 *
							 * No shadow. A black one on a 72%-black backdrop does not read as depth; it
							 * reads as a second, blurry border a few pixels outside the first.
							 */
							className={`${STAGE_FIT} block rounded-xl object-contain`}
						/>
					)}
				</div>
			</div>

			{/* Controls fade in after the image has arrived, so nothing competes with the flight. */}
			<div
				className="pointer-events-none absolute inset-0 transition-opacity duration-[var(--ly-t-base)]"
				style={{ opacity: open ? 1 : 0 }}
			>
				{!editing && (
					<div className="pointer-events-auto absolute top-4 right-4 flex items-center gap-1">
						{/* Offered for every image: one that cannot be replaced can still be annotated and
						    kept, which is the more common reason to mark up something already sent. */}
						<ViewerButton label="标注" onClick={() => setEditing(true)}>
							<Pencil size={15} strokeWidth={1.9} />
						</ViewerButton>
						<ViewerButton label="另存为" onClick={() => download(image.src)}>
							<Download size={15} strokeWidth={1.9} />
						</ViewerButton>
						<ViewerButton label="关闭 Esc" onClick={dismiss}>
							<X size={16} strokeWidth={1.9} />
						</ViewerButton>
					</div>
				)}

				{/*
				 * Bottom left, clear of the annotation toolbar in the middle. Present in both modes:
				 * zooming in to place a mark precisely is the same need as zooming in to read one.
				 */}
				<div className="pointer-events-auto absolute bottom-6 left-6 flex items-center gap-0.5 rounded-xl border border-white/12 bg-[#1c1c1e]/92 px-1.5 py-1 shadow-[0_8px_32px_rgba(0,0,0,0.45)] backdrop-blur-xl">
					<ViewerButton label="缩小" small disabled={zoom <= ZOOM_MIN} onClick={() => zoomTo(zoom / ZOOM_STEP)}>
						<Minus size={14} strokeWidth={2} />
					</ViewerButton>
					<button
						type="button"
						data-ly-tip="恢复原始大小"
						data-ly-tip-side="top"
						aria-label={`当前缩放 ${Math.round(zoom * 100)}%，点击恢复`}
						onClick={resetView}
						className="min-w-[46px] rounded-lg px-1 py-1 text-center text-detail text-white/75 tabular-nums transition-colors duration-[var(--ly-t-quick)] hover:bg-white/12 hover:text-white"
					>
						{Math.round(zoom * 100)}%
					</button>
					<ViewerButton label="放大" small disabled={zoom >= ZOOM_MAX} onClick={() => zoomTo(zoom * ZOOM_STEP)}>
						<Plus size={14} strokeWidth={2} />
					</ViewerButton>
					<ViewerButton label="适应窗口" small onClick={resetView}>
						<Maximize2 size={13} strokeWidth={2} />
					</ViewerButton>
				</div>

				{shown.images.length > 1 && !editing && (
					<>
						<div className="pointer-events-auto absolute top-1/2 left-4 -translate-y-1/2">
							<ViewerButton label="上一张 ←" onClick={() => stepViewer(-1)}>
								<ChevronLeft size={18} strokeWidth={1.9} />
							</ViewerButton>
						</div>
						<div className="pointer-events-auto absolute top-1/2 right-4 -translate-y-1/2">
							<ViewerButton label="下一张 →" onClick={() => stepViewer(1)}>
								<ChevronRight size={18} strokeWidth={1.9} />
							</ViewerButton>
						</div>
						<div className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-2.5 py-1 text-detail text-white/85 tabular-nums">
							{shown.index + 1} / {shown.images.length}
						</div>
					</>
				)}
			</div>

			{editing && (
				<AnnotateToolbar
					annotator={annotator}
					canReplace={Boolean(image.onReplace)}
					onCancel={() => setEditing(false)}
					onSave={() => {
						/*
						 * Replace where that is possible, save a copy where it is not.
						 *
						 * An image already sent is part of the record and rewriting it in place would
						 * change what was said. Handing back a file is the honest version of "keep this"
						 * for one of those — and it is a real outcome rather than a save button that
						 * quietly does nothing.
						 */
						const dataUrl = annotator.render();
						if (!dataUrl) return;
						if (image.onReplace) image.onReplace(dataUrl);
						else download(dataUrl);
						setEditing(false);
						dismiss();
					}}
				/>
			)}
		</div>,
		document.body,
	);
}

function ViewerButton({
	label,
	onClick,
	disabled,
	small,
	children,
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	small?: boolean;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			data-ly-tip={label}
			data-ly-tip-side="top"
			aria-label={label}
			disabled={disabled}
			onClick={onClick}
			className={`flex items-center justify-center rounded-lg text-white/85 transition-colors duration-[var(--ly-t-quick)] hover:text-white disabled:opacity-30 ${
				small ? "h-7 w-7 hover:bg-white/12" : "h-8 w-8 bg-black/45 hover:bg-black/65"
			}`}
		>
			{children}
		</button>
	);
}

/** A `data:` URL is already the file; an anchor is the whole of "save as" for one. */
function download(src: string) {
	const link = document.createElement("a");
	link.href = src;
	link.download = `image-${Date.now()}.png`;
	link.click();
}
