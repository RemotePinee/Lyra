import { Brain, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Markdown } from "./Markdown.tsx";

/**
 * The model's reasoning, behind one line that says it is thinking.
 *
 * Closed by default, live or not. It used to open itself while the turn ran, on the theory that
 * watching the reasoning tells you a long turn is going somewhere — but a long turn is mostly
 * reasoning, so the transcript became a wall of working with the answers lost inside it, and it
 * moved under the reader as every paragraph arrived. The line is enough to say it is thinking;
 * opening it is a question you can ask when you want to.
 *
 * Once opened it stays open, including as the text keeps arriving.
 */
export function ThinkingBlock({ text, redacted, live }: { text: string; redacted: boolean; live?: boolean }) {
	const [open, setOpen] = useState(false);

	if (!text && !redacted) return null;

	return (
		<div className="mb-2.5">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex items-center gap-1.5 rounded-md py-0.5 text-[12px] text-ink-faint transition-colors hover:text-ink-muted"
			>
				<Brain size={13} strokeWidth={1.8} className={live ? "ly-pulse" : undefined} />
				{redacted ? "思考过程（已被安全过滤）" : "思考过程"}
				<ChevronRight
					size={12}
					strokeWidth={2}
					className="transition-transform duration-200"
					style={open ? { transform: "rotate(90deg)" } : undefined}
				/>
			</button>

			{open && !redacted && (
				<div className="ly-enter mt-1.5 border-l-2 border-line pl-3">
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
