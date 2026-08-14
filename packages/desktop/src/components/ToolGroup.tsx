import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Spinner } from "./RunningIndicator.tsx";

/**
 * A run of tool calls, folded into one line.
 *
 * A turn that edits nine files leaves nine cards, and reading back through it means scrolling
 * past all of them to find the sentence that says what happened. Individually each card is
 * worth having — you do sometimes want to know exactly which file — but as a block they are
 * scenery, and they push the actual reply off the screen.
 *
 * Folded while they run, too. That was not the first answer: a card still going seemed like the
 * most interesting thing on the page, so running groups stayed open. In practice a batch of
 * parallel reads is seven cards all saying `read`, each with its own spinner, and seven spinners
 * report nothing that one does. One line and one spinner say the same thing and leave the reply
 * on screen; the detail is a click away for the times it matters.
 */
export function ToolGroup({
	count,
	running,
	label,
	children,
}: {
	count: number;
	/** At least one call in the group has not finished. */
	running?: boolean;
	/** What is happening right now — the running call's own summary, when there is exactly one. */
	label?: string;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const body = useRef<HTMLDivElement>(null);
	const [height, setHeight] = useState(0);

	// Measured rather than guessed, for the same reason as the task list: an animation to a
	// max-height that is not the real one either clips the list or finishes early.
	useEffect(() => {
		const element = body.current;
		if (!element) return;
		const measure = () => setHeight(element.scrollHeight);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [children, open]);

	return (
		<div className={`mb-2 ${running ? "dw-rail overflow-hidden rounded-md" : ""}`}>
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-ink-faint transition-colors hover:bg-card-hover hover:text-ink-muted"
			>
				{running && <Spinner size={11} />}
				{/*
				 * The label changes as the group works through its calls, and changing text that
				 * simply swaps reads as a flicker. Keying the span on the text makes each one a
				 * new element, so it fades in while the old one is already gone — a change you
				 * can follow rather than one you catch out of the corner of your eye.
				 */}
				<span key={label ?? count} className="dw-fade-in">
					{running ? (label ?? `执行 ${count} 个操作`) : `执行了 ${count} 个操作`}
				</span>
				<ChevronDown
					size={12}
					strokeWidth={1.9}
					className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
				/>
			</button>

			<div style={{ height: open ? height : 0 }} className="overflow-hidden transition-[height] duration-200 ease-out">
				<div ref={body} className="pt-1">
					{children}
				</div>
			</div>
		</div>
	);
}
