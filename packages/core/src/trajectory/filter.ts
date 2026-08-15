/**
 * Narrowing a trajectory down to what you came looking for.
 *
 * Two questions, and they compose: which kinds of thing to show, and which words to find. Kept
 * apart from reading so that filtering a loaded trajectory costs nothing — the view re-filters on
 * every keystroke, and re-reading the file for each one would make search feel broken.
 */

import type { Entry, Source } from "./types.ts";

export interface TrajectoryFilter {
	/** Empty or absent means every source. */
	sources?: Source[];
	/** Matched case-insensitively against the summary and the detail. */
	query?: string;
}

export function filterTrajectory(entries: Entry[], filter: TrajectoryFilter = {}): Entry[] {
	const sources = filter.sources?.length ? new Set(filter.sources) : null;
	const query = filter.query?.trim().toLowerCase();

	return entries.filter((entry) => {
		if (sources && !sources.has(entry.source)) return false;
		if (!query) return true;
		return entry.summary.toLowerCase().includes(query) || entry.detail.toLowerCase().includes(query);
	});
}

/** How many entries each source has, so the filter chips can say so. */
export function countBySource(entries: Entry[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const entry of entries) counts[entry.source] = (counts[entry.source] ?? 0) + 1;
	return counts;
}

/**
 * Where a query matches, as offsets into the detail.
 *
 * Returned rather than applied, because highlighting belongs to whatever is drawing the text —
 * the same matches are marked differently in a list row and in a code block.
 */
export function matchRanges(text: string, query: string): { start: number; end: number }[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];
	const haystack = text.toLowerCase();
	const ranges: { start: number; end: number }[] = [];
	let from = 0;
	while (ranges.length < 200) {
		const at = haystack.indexOf(needle, from);
		if (at < 0) break;
		ranges.push({ start: at, end: at + needle.length });
		from = at + needle.length;
	}
	return ranges;
}
