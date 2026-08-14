import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * A run of finished tool calls, folded into one line.
 *
 * A turn that edits nine files leaves nine cards, and reading back through it means scrolling
 * past all of them to find the sentence that says what happened. Individually each card is
 * worth having — you do sometimes want to know exactly which file — but as a block they are
 * scenery, and they push the actual reply off the screen.
 *
 * Folded only once they are all done. While anything is still running, its card is the most
 * interesting thing on the page and stays where it is.
 */
export function ToolGroup({ count, children }: { count: number; children: React.ReactNode }) {
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
		<div className="mb-2">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-ink-faint transition-colors hover:bg-card-hover hover:text-ink-muted"
			>
				<span>执行了 {count} 个操作</span>
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
