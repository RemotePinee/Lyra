/**
 * The image, full size, arriving from wherever you clicked it.
 *
 * The animation is FLIP and it has to be, because the two states have different sizes and there is
 * no single property that gets from one to the other honestly. The final layout is computed first
 * — centred, contained within the window — and then the *first* frame is expressed as a transform
 * that lands the image exactly on the thumbnail it came from. One frame later the transform is
 * removed and the browser interpolates. Nothing is ever laid out at an intermediate size, so a
 * large picture costs the same as a small one and neither reflows on the way.
 *
 * Transform and opacity only, for the same reason: they are the two properties the compositor can
 * animate without asking layout anything. Animating width and height would recompute the image's
 * box on every frame of every open.
 *
 * Closing runs the same path backwards, and only unmounts when it finishes — an overlay that
 * disappears on the click and animates nothing is the thing this replaced.
 */

import { ChevronLeft, ChevronRight, Download, Pencil, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Annotator } from "./Annotator.tsx";
import { closeViewer, stepViewer, useViewer } from "./viewer-store.ts";

/** How much of the window the image may take, leaving room for the controls to sit clear of it. */
const FIT = 0.86;
/** Matches `--ly-t-base`; kept as a number because the unmount has to be timed against it. */
const DURATION = 220;

export function ImageViewer() {
	const state = useViewer();
	const [leaving, setLeaving] = useState(false);
	const [editing, setEditing] = useState(false);
	const figure = useRef<HTMLDivElement>(null);
	const origin = useRef<DOMRect | null>(null);

	// Held across the closing animation, so the image does not vanish before it has shrunk.
	const [held, setHeld] = useState<ReturnType<typeof useViewer>>(null);
	const shown = state ?? held;

	useLayoutEffect(() => {
		if (!state) return;
		setHeld(state);
		setLeaving(false);
		if (state.origin) origin.current = state.origin;
	}, [state]);

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

		// Backwards along the same path: measure where it is now, put it back on the thumbnail.
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
	}, [leaving]);

	useEffect(() => {
		if (!shown) return;
		const onKey = (event: KeyboardEvent) => {
			if (editing) return;
			if (event.key === "Escape") dismiss();
			if (event.key === "ArrowLeft") stepViewer(-1);
			if (event.key === "ArrowRight") stepViewer(1);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [shown, editing, dismiss]);

	if (!shown) return null;
	const image = shown.images[shown.index];
	if (!image) return null;

	const open = !leaving;

	return createPortal(
		<div role="dialog" aria-modal aria-label="图片预览" className="fixed inset-0 z-[100] flex items-center justify-center">
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
				style={{ maxWidth: `${FIT * 100}vw`, maxHeight: `${FIT * 100}vh`, transformOrigin: "center" }}
			>
				{editing ? (
					<Annotator
						src={image.src}
						onCancel={() => setEditing(false)}
						onSave={(dataUrl) => {
							/*
							 * Replace where that is possible, save a copy where it is not.
							 *
							 * An image already sent is part of the record and rewriting it in place would
							 * change what was said. Handing back a file is the honest version of "keep
							 * this" for one of those — and it is a real outcome rather than a save button
							 * that quietly does nothing.
							 */
							if (image.onReplace) image.onReplace(dataUrl);
							else download(dataUrl);
							setEditing(false);
							dismiss();
						}}
						canReplace={Boolean(image.onReplace)}
					/>
				) : (
					<img
						src={image.src}
						alt={image.alt ?? ""}
						draggable={false}
						/*
						 * No shadow. A black one on a 72%-black backdrop does not read as depth — it
						 * reads as a second, blurry border a few pixels outside the first, which is
						 * what the ring around the picture was. The backdrop is already the whole of
						 * the separation between the image and everything behind it.
						 */
						className="block max-h-[86vh] max-w-[86vw] rounded-xl object-contain"
					/>
				)}
			</div>

			{/* Controls fade in after the image has arrived, so nothing competes with the flight. */}
			{!editing && (
				<div
					className="pointer-events-none absolute inset-0 transition-opacity duration-[var(--ly-t-base)]"
					style={{ opacity: open ? 1 : 0 }}
				>
					<div className="pointer-events-auto absolute top-4 right-4 flex items-center gap-1">
						{/* Offered for every image: one that cannot be replaced can still be annotated
						    and kept, which is the more common reason to mark up something already sent. */}
						<ViewerButton label="标注" onClick={() => setEditing(true)}>
							<Pencil size={15} strokeWidth={1.9} />
						</ViewerButton>
						<ViewerButton label="另存为" onClick={() => download(image.src)}>
							<Download size={15} strokeWidth={1.9} />
						</ViewerButton>
						<ViewerButton label="关闭" onClick={dismiss}>
							<X size={16} strokeWidth={1.9} />
						</ViewerButton>
					</div>

					{shown.images.length > 1 && (
						<>
							<div className="pointer-events-auto absolute top-1/2 left-4 -translate-y-1/2">
								<ViewerButton label="上一张" onClick={() => stepViewer(-1)}>
									<ChevronLeft size={18} strokeWidth={1.9} />
								</ViewerButton>
							</div>
							<div className="pointer-events-auto absolute top-1/2 right-4 -translate-y-1/2">
								<ViewerButton label="下一张" onClick={() => stepViewer(1)}>
									<ChevronRight size={18} strokeWidth={1.9} />
								</ViewerButton>
							</div>
							<div className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-2.5 py-1 text-detail text-white/85 tabular-nums">
								{shown.index + 1} / {shown.images.length}
							</div>
						</>
					)}
				</div>
			)}
		</div>,
		document.body,
	);
}

function ViewerButton({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			data-ly-tip={label}
			aria-label={label}
			onClick={onClick}
			className="flex h-8 w-8 items-center justify-center rounded-lg bg-black/45 text-white/85 transition-colors duration-[var(--ly-t-quick)] hover:bg-black/65 hover:text-white"
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
