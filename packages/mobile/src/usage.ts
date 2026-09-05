/**
 * Shared usage aggregations, identical to desktop/src/components/settings/usage-aggregate.ts.
 */

export type Range = 7 | 30 | 0;

export interface UsageBucket {
	day: string;
	key: string;
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	replies: number;
}

export interface UsageDay {
	day: string;
	sessions: number;
	messages: number;
}

export interface UsageScan {
	days: UsageDay[];
	buckets: UsageBucket[];
	scanned: number;
	cached: number;
	tookMs: number;
}

export interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	tokens: number;
	replies: number;
	messages: number;
	sessionDays: number;
	activeDays: number;
}

export interface ModelUse {
	key: string;
	provider: string;
	model: string;
	tokens: number;
	cost: number;
	replies: number;
	share: number;
}

export function dayKey(date: Date): string {
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

export function rangeStart(range: Range, now: Date): string | null {
	if (range === 0) return null;
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	start.setDate(start.getDate() - (range - 1));
	return dayKey(start);
}

export function withinRange<T extends { day: string }>(rows: T[], from: string | null): T[] {
	return from === null ? rows : rows.filter((row) => row.day >= from);
}

export function totalsFor(buckets: UsageBucket[], days: UsageDay[]): Totals {
	const totals: Totals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		tokens: 0,
		replies: 0,
		messages: 0,
		sessionDays: 0,
		activeDays: 0,
	};
	for (const bucket of buckets) {
		totals.input += bucket.input;
		totals.output += bucket.output;
		totals.cacheRead += bucket.cacheRead;
		totals.cacheWrite += bucket.cacheWrite;
		totals.cost += bucket.cost;
		totals.replies += bucket.replies;
		totals.tokens += bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite;
	}
	for (const day of days) {
		totals.messages += day.messages;
		totals.sessionDays += day.sessions;
		if (day.messages > 0) totals.activeDays += 1;
	}
	return totals;
}

export function currentStreak(days: UsageDay[], now: Date): number {
	const active = new Set(days.filter((day) => day.messages > 0).map((day) => day.day));
	const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	if (!active.has(dayKey(cursor))) {
		cursor.setDate(cursor.getDate() - 1);
		if (!active.has(dayKey(cursor))) return 0;
	}
	let streak = 0;
	while (active.has(dayKey(cursor))) {
		streak += 1;
		cursor.setDate(cursor.getDate() - 1);
	}
	return streak;
}

export function modelRanking(buckets: UsageBucket[]): ModelUse[] {
	const byKey = new Map<string, ModelUse>();
	for (const bucket of buckets) {
		const tokens = bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite;
		const seen = byKey.get(bucket.key);
		if (seen) {
			seen.tokens += tokens;
			seen.cost += bucket.cost;
			seen.replies += bucket.replies;
			continue;
		}
		byKey.set(bucket.key, {
			key: bucket.key,
			provider: bucket.provider,
			model: bucket.model,
			tokens,
			cost: bucket.cost,
			replies: bucket.replies,
			share: 0,
		});
	}
	const ranked = [...byKey.values()].sort((a, b) => b.tokens - a.tokens);
	const total = ranked.reduce((sum, each) => sum + each.tokens, 0);
	for (const each of ranked) each.share = total > 0 ? each.tokens / total : 0;
	return ranked;
}

export function summarise(scan: UsageScan, range: Range, now: Date) {
	const from = rangeStart(range, now);
	const buckets = withinRange(scan.buckets, from);
	const days = withinRange(scan.days, from);
	return {
		totals: totalsFor(buckets, days),
		models: modelRanking(buckets),
		streak: currentStreak(scan.days, now),
	};
}
