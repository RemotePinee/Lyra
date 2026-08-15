/**
 * The pull request list: what is in it, and which of it you are looking at.
 *
 * Fetching is one call for the whole list and one more for whichever row is open — the list has
 * everything needed to draw a row, and nothing else. Line counts, the description, the checks and
 * the comments all arrive with the detail, because paying for them thirty times to decorate rows
 * nobody clicked is how a list becomes slow to open.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PullRequestDetail, PullRequestSummary } from "../../../electron/ipc-types.ts";

/** Which pull requests the list is narrowed to. Mirrors the relations the search buckets produce. */
export type Filter = "all" | "reviewing" | "authored";

export interface Group {
	key: PullRequestSummary["relation"];
	label: string;
	items: PullRequestSummary[];
}

const GROUP_LABELS: Record<PullRequestSummary["relation"], string> = {
	reviewing: "等你审查",
	authored: "由我创建",
	reviewed: "之前已审查",
};

/** The order the groups appear in, which is the order they need attention. */
const GROUP_ORDER: PullRequestSummary["relation"][] = ["reviewing", "authored", "reviewed"];

export function usePullRequests() {
	const [items, setItems] = useState<PullRequestSummary[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const [filter, setFilter] = useState<Filter>("all");
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<{ repo: string; number: number } | null>(null);

	const [detail, setDetail] = useState<PullRequestDetail | null>(null);
	const [detailError, setDetailError] = useState<string | null>(null);
	const [detailLoading, setDetailLoading] = useState(false);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			const result = await window.lyra.git.myPullRequests();
			setItems(result.pullRequests);
			setError(result.error ?? null);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	/*
	 * The detail is fetched for whatever is selected, and thrown away when the selection changes.
	 *
	 * `cancelled` matters here: clicking down a list faster than GitHub answers would otherwise
	 * leave whichever request happened to finish last on screen, which is not the one you clicked.
	 */
	useEffect(() => {
		if (!selected) {
			setDetail(null);
			setDetailError(null);
			return;
		}
		let cancelled = false;
		setDetailLoading(true);
		setDetail(null);
		setDetailError(null);
		void window.lyra.git
			.pullRequest(selected.repo, selected.number)
			.then((result) => {
				if (cancelled) return;
				setDetail(result.detail ?? null);
				setDetailError(result.error ?? null);
			})
			.finally(() => {
				if (!cancelled) setDetailLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [selected]);

	const groups = useMemo(() => groupFor(items, filter, query), [items, filter, query]);

	/** Selecting the first row on load, so the pane opposite is never blank for no reason. */
	useEffect(() => {
		if (selected || groups.length === 0) return;
		const first = groups[0].items[0];
		if (first) setSelected({ repo: first.repo, number: first.number });
	}, [groups, selected]);

	return {
		items,
		groups,
		error,
		loading,
		filter,
		setFilter,
		query,
		setQuery,
		selected,
		setSelected,
		detail,
		detailError,
		detailLoading,
		refresh,
		/** Re-read the open one, for after a comment or a review lands. */
		refreshDetail: useCallback(() => setSelected((current) => (current ? { ...current } : null)), []),
	};
}

/** Filter, search, then group — in that order, so a search never resurrects a filtered-out row. */
export function groupFor(items: PullRequestSummary[], filter: Filter, query: string): Group[] {
	const needle = query.trim().toLowerCase();
	const matching = items.filter((pr) => {
		if (filter !== "all" && pr.relation !== filter) return false;
		if (!needle) return true;
		return `${pr.title} ${pr.repo} ${pr.author} #${pr.number}`.toLowerCase().includes(needle);
	});

	return GROUP_ORDER.map((key) => ({
		key,
		label: GROUP_LABELS[key],
		items: matching.filter((pr) => pr.relation === key),
	})).filter((group) => group.items.length > 0);
}
