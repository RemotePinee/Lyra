import { Brain, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Markdown } from "./Markdown.tsx";

/**
 * The model's reasoning, folded away once the turn it belongs to is over.
 *
 * Open while the turn runs, because watching the reasoning is how you tell a long turn is
 * going somewhere. Closed afterwards, because a finished answer should not be buried under
 * the working that produced it. Touching the toggle takes it off the automatic track — a
 * block you deliberately opened stays open.
 */
export function ThinkingBlock({ text, redacted, live }: { text: string; redacted: boolean; live?: boolean }) {
	const [open, setOpen] = useState(live ?? false);
	const [pinned, setPinned] = useState(false);

	useEffect(() => {
		if (!pinned) setOpen(live ?? false);
	}, [live, pinned]);

	if (!text && !redacted) return null;

	return (
		<div className="mb-2.5">
			<button
				type="button"
				onClick={() => {
					setPinned(true);
					setOpen((v) => !v);
				}}
				className="flex items-center gap-1.5 rounded-md py-0.5 text-[12px] text-ink-faint transition-colors hover:text-ink-muted"
			>
				<Brain size={13} strokeWidth={1.8} className={live ? "dw-pulse" : undefined} />
				{redacted ? "思考过程（已被安全过滤）" : "思考过程"}
				<ChevronRight
					size={12}
					strokeWidth={2}
					className="transition-transform duration-200"
					style={open ? { transform: "rotate(90deg)" } : undefined}
				/>
			</button>

			{open && !redacted && (
				<div className="dw-enter mt-1.5 border-l-2 border-line pl-3">
					{/*
					 * Rendered, not raw. Models write their reasoning in markdown — backticked
					 * identifiers, numbered steps, the occasional block — so showing it verbatim
					 * meant reading `handle()` with the backticks still on.
					 */}
					<Markdown text={text} className="text-[12.5px] text-ink-muted" />
				</div>
			)}
		</div>
	);
}
