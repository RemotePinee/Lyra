/**
 * What the pull request pane remembers between visits.
 *
 * Three things, all of them redraws of something GitHub owns: the last list, the pull requests that
 * have been opened, and which rows you have already looked at. None of it is authoritative — it
 * exists so that opening this screen costs nothing, and so that a refresh replaces something
 * readable rather than a spinner.
 *
 * `localStorage` rather than a file through IPC: no more authoritative than a browser's
 * back-forward cache, and it should cost nothing to write. Versioned in the key, so a change to
 * the row shape retires the old entry instead of half-rendering it — and validated on the way out
 * as well, because a version bump only protects against the changes somebody remembered to bump
 * for. A stored value from yesterday crashing the pane today has happened here once already.
 */

import type { PullRequestDetail, PullRequestSummary } from "../../../electron/ipc-types.ts";

/** v1 → v2: rows carry the author's picture, the line counts, the branch and CI's verdict. */
const LIST_KEY = "lyra.pull-requests.v2";
/** v2 → v3: the detail gained the same fields, since the list's shape is the one it extends. */
const DETAIL_KEY = "lyra.pull-request-details.v3";
const SEEN_KEY = "lyra.pull-requests.seen.v1";

/**
 * Bounded, because a detail carries its description, its reviews and its comment threads, and a
 * session of triage would otherwise grow this without limit. Insertion order is the eviction
 * order: the most recently fetched, which for a list this size is everything anybody is switching
 * between.
 */
const DETAIL_LIMIT = 24;

export const rowId = (pr: { repo: string; number: number }) => `${pr.repo}#${pr.number}`;

function read<T>(key: string): T | null {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : null;
	} catch {
		return null;
	}
}

function write(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// A full or disabled store: everything still works, it just opens cold next time.
		try {
			localStorage.removeItem(key);
		} catch {}
	}
}

/**
 * The stored list, with every row checked for the fields a row is drawn from.
 *
 * A row missing one of them is dropped rather than repaired: it came from a version that did not
 * have it, and the refresh already on its way carries a complete one.
 */
export function readList(): PullRequestSummary[] {
	const parsed = read<unknown>(LIST_KEY);
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((row): row is PullRequestSummary => {
		const pr = row as Partial<PullRequestSummary> | null;
		return Boolean(
			pr &&
				typeof pr.repo === "string" &&
				typeof pr.number === "number" &&
				typeof pr.title === "string" &&
				typeof pr.updatedAt === "string" &&
				(pr.relation === "reviewing" || pr.relation === "authored" || pr.relation === "reviewed"),
		);
	});
}

export function writeList(items: PullRequestSummary[]): void {
	write(LIST_KEY, items);
}

function readDetails(): Record<string, PullRequestDetail> {
	const parsed = read<Record<string, PullRequestDetail>>(DETAIL_KEY);
	return parsed && typeof parsed === "object" ? parsed : {};
}

export function readDetail(id: string): PullRequestDetail | null {
	const stored = readDetails()[id];
	// The checks section iterates `items`; an entry written before that field existed crashed the
	// whole pane, and would have gone on crashing until somebody cleared their storage.
	if (!stored || typeof stored.title !== "string") return null;
	if (stored.checks && !Array.isArray(stored.checks.items)) return null;
	return stored;
}

export function writeDetail(id: string, detail: PullRequestDetail): void {
	const all = readDetails();
	// Delete first, so re-fetching an old one moves it to the back of the queue rather than leaving
	// it next in line to be dropped.
	delete all[id];
	all[id] = detail;
	const keys = Object.keys(all);
	for (const stale of keys.slice(0, Math.max(0, keys.length - DETAIL_LIMIT))) delete all[stale];
	write(DETAIL_KEY, all);
}

/**
 * When each row was last looked at, by `updatedAt`.
 *
 * Null means never recorded, which is a real answer and not an empty one: it is the difference
 * between a first run — where marking sixty rows as new would be noise — and a store that has been
 * kept and simply has nothing in it yet.
 */
export function readSeen(): Record<string, string> | null {
	const parsed = read<Record<string, string>>(SEEN_KEY);
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

export function writeSeen(seen: Record<string, string>): void {
	write(SEEN_KEY, seen);
}
