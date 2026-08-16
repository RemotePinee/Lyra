/**
 * What happened on this pull request, in the order it happened.
 *
 * Reviews and comments were two lists under two headings, which is how GitHub's API returns them
 * and not how anybody reads a pull request. A review that answers the comment above it belongs
 * under that comment; split apart, the reader has to interleave two timestamped lists by hand.
 *
 * Each entry is collapsed to its author and a first line, and opens to the whole thing. Bodies
 * here run to screens — a CI bot posting an analysis, a reviewer pasting a stack trace — and a
 * page that opens with four of those expanded is a page where the summary above them is already
 * off-screen.
 */

import { ChevronDown, ExternalLink } from "lucide-react";
import { useState } from "react";
import { relativeTime } from "../git/relative-time.ts";
import { type ActivityEntry, firstLine } from "./activity.ts";
import { Markdown } from "../Markdown.tsx";

export function PullRequestActivity({ entries }: { entries: ActivityEntry[] }) {
	/*
	 * Nothing is open to begin with, except a lone entry.
	 *
	 * One comment on a pull request is the comment — collapsing it makes the reader open the only
	 * thing there is. Past that, everything starts closed and the timeline stays readable as a
	 * timeline.
	 */
	const [open, setOpen] = useState<Record<string, boolean>>(() =>
		entries.length === 1 ? { [entries[0].key]: true } : {},
	);

	return (
		<div className="flex flex-col gap-1.5">
			{entries.map((entry) => {
				const expanded = open[entry.key] === true;
				const empty = !entry.body.trim();

				return (
					<article key={entry.key} className="overflow-hidden rounded-[10px] border border-line-soft">
						<button
							type="button"
							disabled={empty}
							aria-expanded={expanded}
							onClick={() => setOpen((prev) => ({ ...prev, [entry.key]: !prev[entry.key] }))}
							className="ly-item flex w-full items-center gap-2 px-3 py-2 text-left disabled:cursor-default"
						>
							<span className="shrink-0 text-label text-ink">{entry.author}</span>
							{entry.verdict && <span className="shrink-0 text-detail text-ink-faint">{entry.verdict}</span>}

							{/* The first line, so a collapsed row still says what it is about. */}
							{!expanded && !empty && (
								<span className="min-w-0 flex-1 truncate text-detail text-ink-faint">{firstLine(entry.body)}</span>
							)}
							{empty && <span className="min-w-0 flex-1 text-detail text-ink-faint">（没有留下文字）</span>}
							{expanded && <div className="flex-1" />}

							<span className="shrink-0 text-detail text-ink-faint tabular-nums">{relativeTime(entry.at)}</span>
							{!empty && (
								<ChevronDown
									size={13}
									strokeWidth={2}
									className="shrink-0 text-ink-faint transition-transform duration-[var(--ly-t-base)] ease-[var(--ly-e-out)]"
									style={{ transform: expanded ? "rotate(180deg)" : undefined }}
								/>
							)}
						</button>

						<div className="ly-reveal" data-open={expanded && !empty} aria-hidden={!expanded}>
							<div>
								<div className="border-t border-line-soft px-3 py-2.5">
									<Markdown text={entry.body} className="text-label" />
								</div>
							</div>
						</div>
					</article>
				);
			})}
		</div>
	);
}

/** A link out, for the header of the section. */
export function ActivityLink({ url }: { url: string }) {
	return (
		<button
			type="button"
			data-ly-tip="在浏览器中查看全部"
			aria-label="在浏览器中查看全部活动"
			onClick={() => void window.lyra.system.openExternal(url)}
			className="shrink-0 rounded-md p-1 text-ink-faint transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover hover:text-ink"
		>
			<ExternalLink size={12.5} strokeWidth={1.8} />
		</button>
	);
}
