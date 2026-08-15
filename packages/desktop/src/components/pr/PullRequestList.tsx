/**
 * The list of pull requests, grouped by why each one is there.
 *
 * A flat list sorted by date answers "what changed recently", which is not the question. The
 * question is "what is waiting on me" — so the groups are the relations, in the order they need
 * attention, and the filter above is the same three answers stated as a choice.
 */

import { GitPullRequest, Search } from "lucide-react";
import type { PullRequestSummary } from "../../../electron/ipc-types.ts";
import { relativeTime } from "../git/relative-time.ts";
import { ScrollText } from "../ScrollText.tsx";
import { Scroller } from "../Scroller.tsx";
import { Text } from "../Text.tsx";
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
}) {
	const empty = groups.length === 0;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 px-3 pt-3 pb-2">
				<div className="flex items-center gap-0.5 pb-2.5">
					{FILTERS.map((option) => (
						<button
							key={option.key}
							type="button"
							onClick={() => onFilter(option.key)}
							className={`h-[26px] rounded-lg px-2.5 text-[12.5px] transition-colors ${
								filter === option.key ? "bg-card-hover text-ink" : "text-ink-muted hover:text-ink"
							}`}
						>
							{option.label}
						</button>
					))}
				</div>

				<label className="flex h-[32px] items-center gap-2 rounded-[9px] border border-line px-2.5 focus-within:border-ink-faint">
					<Search size={13} strokeWidth={1.9} className="shrink-0 text-ink-faint" />
					<input
						value={query}
						onChange={(event) => onQuery(event.target.value)}
						placeholder="搜索 Pull Request"
						spellCheck={false}
						className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink placeholder:text-ink-faint focus:outline-none"
					/>
				</label>
			</div>

			<Scroller className="flex-1" contentClassName="px-2 pb-3" fadeColor="var(--color-shell)">
				{error && (
					<p className="mx-1 mt-2 rounded-[9px] border border-accent/35 bg-accent/8 px-3 py-2 text-[12px] leading-relaxed text-accent">
						{error}
					</p>
				)}

				{empty && !error && (
					<p className="px-3 py-16 text-center text-[12.5px] text-ink-faint">
						{loading ? "正在读取…" : query ? "没有匹配的 Pull Request" : "没有和你有关的 Pull Request"}
					</p>
				)}

				{groups.map((group) => (
					<section key={group.key} className="pt-3 first:pt-1">
						<div className="px-2 pb-1 text-[11.5px] text-ink-faint">{group.label}</div>
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
			className={`ly-scroll flex w-full gap-2.5 rounded-[9px] px-2 py-2 text-left transition-colors duration-150 ${
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
					<ScrollText text={pr.title} className="min-w-0 flex-1 text-[12.5px] text-ink" />
					<Text size="caption" tone="faint" numeric className="shrink-0">
						{relativeTime(pr.updatedAt)}
					</Text>
				</div>
				<div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-faint">
					<ScrollText text={pr.repo} className="min-w-0 shrink truncate" />
					<span className="shrink-0 font-mono">#{pr.number}</span>
					{pr.isDraft && <span className="shrink-0 rounded bg-card px-1.5">草稿</span>}
					{pr.comments > 0 && <span className="shrink-0">{pr.comments} 条评论</span>}
				</div>
			</div>
		</button>
	);
}
