/**
 * One entry in the trajectory, closed and open.
 *
 * Closed it is a source, a time and a line. Open it is the whole thing — the system prompt in full,
 * a tool's arguments and what came back, the prompt a sub-agent was sent off with. That is the
 * point of keeping the log: being able to read what the model actually saw, not a paraphrase.
 *
 * "从这里分叉" sits in the open state rather than on hover, because forking is a deliberate act and
 * a button that appears under the pointer invites the accidental kind.
 */

import { GitBranch } from "lucide-react";
import { SOURCE_LABEL, matchRanges, type Entry as TrajectoryEntry } from "@deepwise/core/trajectory-view";
import { Text } from "../Text.tsx";

export function EntryRow({
	entry,
	open,
	query,
	onToggle,
	onFork,
}: {
	entry: TrajectoryEntry;
	open: boolean;
	query: string;
	onToggle: () => void;
	onFork: () => void;
}) {
	return (
		<div>
			<button
				type="button"
				onClick={onToggle}
				className={`dw-scroll flex w-full items-start gap-2 rounded-md px-1.5 py-[5px] text-left hover:bg-card/60 ${
					open ? "bg-card/60" : ""
				}`}
			>
				<span className="mt-[2px] shrink-0 rounded px-1 py-[1px] text-[10px] text-ink-faint tabular-nums">
					{SOURCE_LABEL[entry.source]}
				</span>
				<span className="min-w-0 flex-1 truncate text-[12px] text-ink-muted">
					<Highlighted text={entry.summary} query={query} />
				</span>
				<Text size="caption" tone="faint" numeric className="mt-[2px] shrink-0">
					#{entry.seq}
				</Text>
			</button>

			{open && (
				<div className="dw-enter mb-1 ml-[21px] rounded-md border border-line-soft bg-card/40 px-2.5 py-2">
					<pre className="max-h-[min(360px,44vh)] overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-muted">
						<Highlighted text={entry.detail} query={query} />
					</pre>
					<div className="mt-2 flex items-center justify-between border-t border-line-soft pt-2">
						<Text size="caption" tone="faint" numeric>
							{new Date(entry.ts).toLocaleString("zh-CN")}
						</Text>
						<button
							type="button"
							onClick={onFork}
							className="dw-item flex items-center gap-1 rounded-md px-1.5 py-[3px] text-[11px] text-ink-muted"
							title="用这一刻之前的历史开一个新会话，原会话不受影响"
						>
							<GitBranch size={11} strokeWidth={1.8} />
							从这里分叉
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

/** The searched-for words, marked where they occur. */
function Highlighted({ text, query }: { text: string; query: string }) {
	const ranges = query.trim() ? matchRanges(text, query) : [];
	if (ranges.length === 0) return <>{text}</>;

	const parts: React.ReactNode[] = [];
	let at = 0;
	for (const [index, range] of ranges.entries()) {
		if (range.start > at) parts.push(text.slice(at, range.start));
		parts.push(
			<mark key={index} className="rounded-[2px] bg-accent/20 text-ink">
				{text.slice(range.start, range.end)}
			</mark>,
		);
		at = range.end;
	}
	if (at < text.length) parts.push(text.slice(at));
	return <>{parts}</>;
}
