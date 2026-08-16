/**
 * The list of pull requests, grouped by why each one is there.
 *
 * A flat list sorted by date answers "what changed recently", which is not the question. The
 * question is "what is waiting on me" — so the groups are the relations, in the order they need
 * attention, and the filter above is the same three answers stated as a choice.
 */

import { GitPullRequest, RefreshCw, Search } from "lucide-react";
import type { PullRequestSummary } from "../../../electron/ipc-types.ts";
import { relativeTime } from "../git/relative-time.ts";
import { ScrollText } from "../ScrollText.tsx";
import { Scroller } from "../Scroller.tsx";
import { Text } from "../Text.tsx";
import { ListSkeleton } from "./PullRequestSkeleton.tsx";
import type { Filter, Group } from "./usePullRequests.ts";

const FILTERS: { key: Filter; label: string }[] = [
	{ key: "all", label: "全部" },
	{ key: "reviewing", label: "正在审查" },
	{ key: "authored", label: "由我创建" },
];

export function PullRequestList({
	groups,
	filter,
	onFilter,
	query,
	onQuery,
	selected,
	onSelect,
	loading,
	error,
	onRefresh,
	toolbarLeft,
}: {
	groups: Group[];
	filter: Filter;
	onFilter: (filter: Filter) => void;
	query: string;
	onQuery: (query: string) => void;
	selected: { repo: string; number: number } | null;
	onSelect: (pr: PullRequestSummary) => void;
	loading: boolean;
	error: string | null;
	onRefresh: () => void;
	/** Left inset that keeps this clear of the window controls; 0 when the sidebar covers them. */
	toolbarLeft: number;
}) {
	const empty = groups.length === 0;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/*
			 * Sits in the strip the shell reserves for the window controls, so it lines up with the
			 * sidebar's collapse button rather than starting a second row 44px below it.
			 *
			 * `no-drag` because that strip is what moves the window: without it these are decoration
			 * you cannot click. `relative z-50` to come out from under the drag band, which covers
			 * the full width at z-40.
			 */}
			<div
				className="no-drag relative z-50 flex h-11 shrink-0 items-center gap-0.5 px-3"
				/*
				 * Clear of the window's own controls when the sidebar is not covering them.
				 *
				 * Closed, this column starts at the window's left edge — right on top of the traffic
				 * lights and the sidebar toggle, which are drawn above it. The filters were both
				 * overlapping them and unclickable.
				 */
				style={{ paddingLeft: toolbarLeft ? toolbarLeft : undefined }}
			>
					{FILTERS.map((option) => (
						<button
							key={option.key}
							type="button"
							onClick={() => onFilter(option.key)}
							className={`h-[26px] shrink-0 rounded-lg px-2.5 text-label whitespace-nowrap transition-colors ${
								filter === option.key ? "bg-card-hover text-ink" : "text-ink-muted hover:text-ink"
							}`}
						>
							{option.label}
						</button>
					))}

					<div className="flex-1" />
					<button
						type="button"
						data-ly-tip="刷新"
						aria-label="刷新"
						onClick={onRefresh}
						className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-card-hover hover:text-ink"
					>
						<RefreshCw size={13} strokeWidth={1.8} className={loading ? "ly-spin" : undefined} />
					</button>
			</div>

			<div className="shrink-0 px-3 pt-1 pb-2">
				<label className="flex h-[32px] items-center gap-2 rounded-[9px] border border-line px-2.5 focus-within:border-ink-faint">
					<Search size={13} strokeWidth={1.9} className="shrink-0 text-ink-faint" />
					<input
						value={query}
						onChange={(event) => onQuery(event.target.value)}
						placeholder="搜索 Pull Request"
						spellCheck={false}
						className="min-w-0 flex-1 bg-transparent text-label text-ink placeholder:text-ink-faint focus:outline-none"
					/>
				</label>
			</div>

			<Scroller className="flex-1" contentClassName="px-2 pb-3">
				{error && (
					<p className="mx-1 mt-2 rounded-[9px] border border-accent/35 bg-accent/8 px-3 py-2 text-detail leading-relaxed text-accent">
						{error}
					</p>
				)}

				{/*
				 * The skeleton is only for a genuinely cold pane. With rows already on screen from
				 * the cache, a refresh says so through the spinning arrow above and leaves the list
				 * alone — replacing readable rows with grey blocks would be a downgrade, not
				 * feedback.
				 */}
				{empty && !error && loading && <ListSkeleton />}

				{empty && !error && !loading && (
					<p className="px-3 py-16 text-center text-label text-ink-faint">
						{query ? "没有匹配的 Pull Request" : "没有和你有关的 Pull Request"}
					</p>
				)}

				{groups.map((group) => (
					<section key={group.key} className="pt-3 first:pt-1">
						<div className="px-2 pb-1 text-detail text-ink-faint">{group.label}</div>
						{group.items.map((pr) => (
							<Row
								key={`${pr.repo}#${pr.number}`}
								pr={pr}
								active={selected?.repo === pr.repo && selected.number === pr.number}
								onSelect={() => onSelect(pr)}
							/>
						))}
					</section>
				))}
			</Scroller>
		</div>
	);
}

function Row({ pr, active, onSelect }: { pr: PullRequestSummary; active: boolean; onSelect: () => void }) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className={`ly-scroll flex w-full gap-2.5 rounded-[9px] px-2 py-2 text-left transition-colors duration-[var(--ly-t-quick)] ${
				active ? "bg-card-hover" : "hover:bg-card-hover/60"
			}`}
		>
			{/*
			 * A draft is grey, an open one green — the same two states GitHub draws, because this
			 * is a list people cross-reference with the web page.
			 */}
			<GitPullRequest
				size={13.5}
				strokeWidth={1.9}
				className={`mt-[3px] shrink-0 ${pr.isDraft ? "text-ink-faint" : "text-ok"}`}
			/>

			<div className="min-w-0 flex-1">
				<div className="flex items-baseline gap-2">
					<ScrollText text={pr.title} className="min-w-0 flex-1 text-label text-ink" />
					<Text size="caption" tone="faint" numeric className="shrink-0">
						{relativeTime(pr.updatedAt)}
					</Text>
				</div>
				<div className="mt-0.5 flex items-center gap-1.5 text-detail text-ink-faint">
					<ScrollText text={pr.repo} className="min-w-0 shrink truncate" />
					<span className="shrink-0 font-mono">#{pr.number}</span>
					{pr.isDraft && <span className="shrink-0 rounded bg-card px-1.5">草稿</span>}
					{pr.comments > 0 && <span className="shrink-0">{pr.comments} 条评论</span>}
				</div>
			</div>
		</button>
	);
}
