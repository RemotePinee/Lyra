/**
 * The bands over the flat conversation list.
 *
 * Date arithmetic that looks obvious and is not. Two of these are the cases that make a band lie
 * about itself: a conversation from 11pm yesterday filed under 「今天」 because it is fourteen hours
 * old, and the whole list shifting one band on the two mornings a year a local day is not 24 hours.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { bandByRecency } from "../src/components/sidebar/recency.ts";

type Session = Parameters<typeof bandByRecency>[0][number];

function session(id: string, updatedAt: number): Session {
	return {
		id,
		title: id,
		cwd: "/a",
		projectName: "a",
		messageCount: 2,
		archived: false,
		updatedAt,
		createdAt: updatedAt,
	} as Session;
}

/** A local wall-clock instant, so the bands are exercised the way the user's clock reads them. */
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

const NOW = at(2026, 8, 25, 14);

function bandOf(updatedAt: number, now = NOW): string | undefined {
	return bandByRecency([session("s", updatedAt)], now)[0]?.label;
}

test("bands are cut on calendar days, not on hours elapsed", () => {
	// Fourteen hours old, and still yesterday — which is the only thing 「昨天」 can mean.
	assert.equal(bandOf(at(2026, 8, 25, 0, )), "今天");
	assert.equal(bandOf(at(2026, 8, 24, 23)), "昨天");
	assert.equal(bandOf(at(2026, 8, 24, 0)), "昨天");
});

test("each cut is inclusive of its own edge", () => {
	assert.equal(bandOf(at(2026, 8, 18)), "过去 7 天", "seven days back is still the seven-day band");
	assert.equal(bandOf(at(2026, 8, 17)), "过去 30 天", "eight is not");
	assert.equal(bandOf(at(2026, 7, 26)), "过去 30 天", "thirty days back");
	assert.equal(bandOf(at(2026, 7, 25)), "更早", "thirty-one");
});

/*
 * The clocks going forward makes a local day 23 hours long. Dividing the gap by a fixed 86 400 000
 * and flooring it gives zero for that day, which would have moved every one of yesterday's
 * conversations into 「今天」 on one morning a year — under a heading that was simply untrue.
 */
test("a short or long local day does not move a conversation into the wrong band", () => {
	for (const [year, month, day] of [
		[2026, 3, 8], // US spring forward
		[2026, 11, 1], // US fall back
		[2026, 3, 29], // EU spring forward
	] as const) {
		const morning = at(year, month, day, 10);
		const dayBefore = at(year, month, day - 1, 22);
		assert.equal(bandOf(dayBefore, morning), "昨天", `${year}-${month}-${day} lost a day`);
	}
});

test("a clock that reads into the future files under today rather than inventing a band", () => {
	assert.equal(bandOf(NOW + 86_400_000 * 3), "今天");
});

test("bands come newest first, and so do the rows inside them", () => {
	const bands = bandByRecency(
		[
			session("old", at(2026, 1, 1)),
			session("today-early", at(2026, 8, 25, 1)),
			session("week", at(2026, 8, 21)),
			session("today-late", at(2026, 8, 25, 13)),
		],
		NOW,
	);
	assert.deepEqual(
		bands.map((band) => band.label),
		["今天", "过去 7 天", "更早"],
		"and a band nothing fell into is not drawn at all",
	);
	assert.deepEqual(
		bands[0].sessions.map((s) => s.id),
		["today-late", "today-early"],
	);
});

test("banding does not reorder the array it was given", () => {
	const input = [session("a", at(2026, 1, 1)), session("b", NOW)];
	bandByRecency(input, NOW);
	assert.deepEqual(
		input.map((s) => s.id),
		["a", "b"],
		"the caller's list is its own; sorting it in place would reorder what React is rendering",
	);
});
