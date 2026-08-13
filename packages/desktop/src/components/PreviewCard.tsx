import { ExternalLink, Maximize2, Minimize2, RotateCw } from "lucide-react";
import { useState } from "react";

import { IconButton } from "./IconButton.tsx";
import { useSide } from "../sideStore.ts";

export interface PreviewInfo {
	id: string;
	sessionId: string;
	title: string;
	entry: string;
}

export function previewUrl(preview: PreviewInfo): string {
	return `dw-preview://${preview.sessionId}/${preview.id}/${preview.entry}`;
}

/**
 * A page the agent made, running inside the conversation.
 *
 * The point is that a demo is not a description of a demo: a snake game you can play settles
 * in one second what a fenced code block takes a paragraph to explain, and a layout put up for
 * approval is answered by looking at it. So it renders here, in place, already interactive.
 *
 * It is a piece of the conversation, not an application window sitting in one. There was a title
 * bar here — a name and three buttons across the top, on a card with its own border — and it
 * announced itself twice: the page nearly always opens with its own heading, and the bar repeated
 * it above a strip of chrome that did nothing until you wanted it. Now the page is simply there,
 * and the controls surface on hover the way a message's own actions do.
 *
 * Inside a sandboxed frame with `allow-scripts` and nothing else — no same-origin, so it cannot
 * reach this window; no top-navigation, so it cannot replace the app with something else. It is
 * served from its own `dw-preview://` origin rather than `file://`, which is what keeps it from
 * walking the disk. The agent wrote this code; it is not trusted with anything but its own
 * canvas.
 */
export function PreviewCard({ preview }: { preview: PreviewInfo }) {
	const [nonce, setNonce] = useState(0);
	const [tall, setTall] = useState(false);
	const [ready, setReady] = useState(false);
	const openTab = useSide((s) => s.openTab);
	const openPreview = useSide((s) => s.openPreview);

	return (
		<div
			className={`dw-enter relative my-2.5 overflow-hidden rounded-[12px] border border-line-soft transition-[height] duration-200 ${
				tall ? "h-[620px]" : "h-[440px]"
			}`}
		>
			{/*
			 * The frame fades in over the card's own colour rather than appearing on white.
			 *
			 * Every preview starts as a blank document, and a blank document is white — which on a
			 * dark theme is a flash bright enough to be the most noticeable thing about the whole
			 * feature. Holding it back until the page has painted costs nothing and removes it.
			 */}
			<div className="h-full w-full bg-card">
				<iframe
					key={nonce}
					src={previewUrl(preview)}
					title={preview.title}
					sandbox="allow-scripts allow-pointer-lock allow-forms allow-modals"
					onLoad={() => setReady(true)}
					className={`block h-full w-full transition-opacity duration-200 ${ready ? "opacity-100" : "opacity-0"}`}
				/>
			</div>

			{/*
			 * Floating over the page, faint until you go for them.
			 *
			 * Elsewhere in the app controls like these stay hidden until the pointer is on what they
			 * act on. Not here: the page fills the card, so nearly every position the pointer can
			 * take is inside a cross-process frame, and whether that hover reaches this document is
			 * not something that could be established either way. Rather than stake the only way to
			 * rerun or reopen a preview on it, they stay — quiet enough to read as part of the page,
			 * and solid the moment the pointer arrives, which is a hover this document does own.
			 */}
			<div className="dw-glass absolute top-2 right-2 flex items-center gap-0.5 rounded-lg p-0.5 opacity-45 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100">
				{/*
				 * Taller, because the frame cannot ask for a size.
				 *
				 * A page laid out against the viewport — which is most games and most dashboards —
				 * reports exactly the height it was given, so there is nothing to measure and grow
				 * to. The default suits a diagram or a form; anything built to fill a screen gets
				 * cropped at the bottom, and this is the one click that fixes it.
				 */}
				<IconButton
					icon={tall ? <Minimize2 size={12} strokeWidth={1.9} /> : <Maximize2 size={12} strokeWidth={1.9} />}
					label={tall ? "还原高度" : "增加高度"}
					size="sm"
					tipSide="top"
					onClick={() => setTall((value) => !value)}
				/>
				<IconButton
					icon={<RotateCw size={12} strokeWidth={1.9} />}
					label="重新运行"
					size="sm"
					tipSide="top"
					onClick={() => {
						setReady(false);
						setNonce((value) => value + 1);
					}}
				/>
				<IconButton
					icon={<ExternalLink size={12} strokeWidth={1.9} />}
					label="在侧栏中打开"
					size="sm"
					tipSide="top"
					onClick={() => {
						openPreview(preview);
						openTab("browser");
					}}
				/>
			</div>
		</div>
	);
}
