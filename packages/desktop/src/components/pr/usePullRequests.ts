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

/*
 * Last known list, kept across launches.
 *
 * `gh search prs` is three round trips to GitHub and takes seconds — which is fine as the cost of
 * finding out what changed, and not fine as the cost of opening a screen. Without this, every
 * visit started from an empty pane and a spinner, including the visits where nothing had changed
 * and including the first one after a restart.
 *
 * So the list renders from what it saw last and refreshes underneath. Stale-but-there beats
 * blank-but-honest for something you are about to replace in a second either way, and it is what
 * makes reopening the pane feel instant rather than merely fast.
 *
 * `localStorage` rather than a file through IPC: this is a redraw of a remote list, no more
 * authoritative than a browser's back-forward cache, and it should cost nothing to write.
 * Versioned in the key, so a change to the row shape retires the old entry instead of
 * half-rendering it.
 */
const CACHE_KEY = "lyra.pull-requests.v1";

function readCache(): PullRequestSummary[] {
	try {
		const raw = localStorage.getItem(CACHE_KEY);
		const parsed = raw ? JSON.parse(raw) : null;
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * When the list last came back, shared by every mount of this hook.
 *
 * Module scope on purpose: the point is to survive the hook, since what triggers a needless fetch
 * is leaving this screen and coming back — which unmounts it. Not persisted, because a fetch on
 * the first visit after launch is one worth making.
 */
let lastFetch = 0;
const FRESH_MS = 60_000;

function writeCache(items: PullRequestSummary[]): void {
	try {
		localStorage.setItem(CACHE_KEY, JSON.stringify(items));
	} catch {
		// A full or disabled store: the list still works, it just opens cold next time.
	}
}

/*
 * The same treatment for whichever ones have been opened.
 *
 * Caching the list alone still left every click on a row costing a round trip, including clicking
 * back to the row you were just on — which is the click most likely to happen while comparing two
 * pull requests, and the one where a spinner is least defensible. A review is read, then
 * re-opened, then read again.
 *
 * Bounded, because a detail carries its description, its reviews and its comment threads, and
 * a session of triage would otherwise grow this without limit. Insertion order is the eviction
 * order: the twenty-four most recently *fetched*, which for a list this size is everything
 * anybody is switching between.
 */
/*
 * Bumped whenever the shape changes.
 *
 * v1 → v2: checks gained the per-check list. A cache entry written before that has a `checks`
 * object with no `items`, and the section that renders them iterated it — a stored value from
 * yesterday crashed the whole pane today, and it would have kept crashing until someone cleared
 * their storage.
 *
 * That is the standing hazard with any cache of a structure that is still moving: the reader is
 * always newer than the thing it is reading. The version is one half of the answer and the
 * validation on the way out is the other, because a bump only protects against changes somebody
 * remembered to bump for.
 */
const DETAIL_KEY = "lyra.pull-request-details.v2";
const DETAIL_LIMIT = 24;

const detailId = (repo: string, number: number) => `${repo}#${number}`;

function readDetails(): Record<string, PullRequestDetail> {
	try {
		const raw = localStorage.getItem(DETAIL_KEY);
		const parsed = raw ? JSON.parse(raw) : null;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function readDetail(id: string): PullRequestDetail | null {
	return readDetails()[id] ?? null;
}

function writeDetail(id: string, detail: PullRequestDetail): void {
	try {
		const all = readDetails();
		// Delete first, so re-fetching an old one moves it to the back of the queue rather than
		// leaving it next in line to be dropped.
		delete all[id];
		all[id] = detail;
		const keys = Object.keys(all);
		for (const stale of keys.slice(0, Math.max(0, keys.length - DETAIL_LIMIT))) delete all[stale];
		localStorage.setItem(DETAIL_KEY, JSON.stringify(all));
	} catch {
		// Out of room: drop the whole cache rather than leave a half-written one behind.
		try {
			localStorage.removeItem(DETAIL_KEY);
		} catch {}
	}
}

export function usePullRequests() {
	const [items, setItems] = useState<PullRequestSummary[]>(readCache);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const [filter, setFilter] = useState<Filter>("all");
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<{ repo: string; number: number } | null>(null);

	const [detail, setDetail] = useState<PullRequestDetail | null>(null);
	const [detailError, setDetailError] = useState<string | null>(null);
	const [detailLoading, setDetailLoading] = useState(false);

	const refresh = useCallback(async ({ stale = false } = {}) => {
		// Reopening the screen is not a reason to ask again. The list is a few dozen pull requests
		// that change over hours, and coming back to it a few seconds later already has the answer.
		if (stale && Date.now() - lastFetch < FRESH_MS) return;
		setLoading(true);
		try {
			const result = await window.lyra.git.myPullRequests();
			/*
			 * A failed refresh keeps what is already on screen.
			 *
			 * `gh` reports every failure the same way — an empty list and a message — so replacing
			 * the rows unconditionally meant one expired token, one flaky network or one rate limit
			 * wiped a list that was still perfectly good, and did it on a timer nobody asked for.
			 * The error is worth showing; discarding the answer alongside it is not.
			 */
			if (result.error && result.pullRequests.length === 0) {
				setError(result.error);
				return;
			}
			setItems(result.pullRequests);
			writeCache(result.pullRequests);
			setError(result.error ?? null);
			lastFetch = Date.now();
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh({ stale: true });
	}, [refresh]);

	/*
	 * The detail for whatever is selected: shown from cache at once, then refreshed underneath.
	 *
	 * Blanking the pane before every fetch is what made switching rows feel slow even when the
	 * answer was already known. A pull request that has been opened before is drawn on the same
	 * frame as the click, and the request that follows only ever replaces it with something newer.
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
		const id = detailId(selected.repo, selected.number);
		const cached = readDetail(id);

		setDetail(cached);
		setDetailError(null);
		// Only a pane with nothing in it is loading. With a cached copy up, the header's spinner
		// carries the refresh and the content stays readable throughout.
		setDetailLoading(!cached);

		void window.lyra.git
			.pullRequest(selected.repo, selected.number)
			.then((result) => {
				if (cancelled) return;
				if (result.detail) {
					setDetail(result.detail);
					writeDetail(id, result.detail);
					setDetailError(null);
					return;
				}
				// A failure with something already on screen is reported by leaving it there: the
				// cached review is still the truth as of the last time anyone could reach GitHub.
				if (!cached) setDetailError(result.error ?? null);
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
		refresh: useCallback(() => void refresh(), [refresh]),
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
