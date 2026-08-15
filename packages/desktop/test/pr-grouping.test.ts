/**
 * Which pull requests appear, and under which heading.
 *
 * The list answers "what is waiting on me", and that answer is built from three overlapping
 * searches. The rules for turning them into one list are the sort that look obvious until they
 * are wrong: a filter that a search can undo, a group that keeps a row it no longer matches.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullRequestSummary } from "../electron/ipc-shapes.ts";
import { groupFor } from "../src/components/pr/usePullRequests.ts";

function pr(over: Partial<PullRequestSummary> & { relation: PullRequestSummary["relation"] }): PullRequestSummary {
	return {
		repo: "kittors/lyra",
		number: 1,
		title: "fix: something",
		author: "someone",
		state: "OPEN",
		isDraft: false,
		url: "https://github.com/kittors/lyra/pull/1",
		createdAt: "2026-08-01T00:00:00Z",
		updatedAt: "2026-08-02T00:00:00Z",
		comments: 0,
		additions: null,
		deletions: null,
		headRefName: null,
		...over,
	};
}

test("groups come in the order they need attention", () => {
	const groups = groupFor(
		[pr({ relation: "reviewed", number: 3 }), pr({ relation: "authored", number: 2 }), pr({ relation: "reviewing", number: 1 })],
		"all",
		"",
	);
	assert.deepEqual(
		groups.map((g) => g.key),
		["reviewing", "authored", "reviewed"],
		"what is asked of you comes before what you are waiting on",
	);
});

test("an empty group is not a heading with nothing under it", () => {
	const groups = groupFor([pr({ relation: "authored" })], "all", "");
	assert.deepEqual(
		groups.map((g) => g.key),
		["authored"],
	);
});

test("the filter narrows to one relation", () => {
	const items = [pr({ relation: "authored", number: 1 }), pr({ relation: "reviewing", number: 2 })];
	assert.deepEqual(
		groupFor(items, "authored", "").flatMap((g) => g.items.map((i) => i.number)),
		[1],
	);
	assert.deepEqual(
		groupFor(items, "reviewing", "").flatMap((g) => g.items.map((i) => i.number)),
		[2],
	);
});

test("search matches the title, the repository, the author and the number", () => {
	const items = [
		pr({ relation: "authored", number: 11, title: "fix: guard against empty name" }),
		pr({ relation: "authored", number: 12, repo: "farion1231/cc-switch", title: "feat: catalog" }),
		pr({ relation: "authored", number: 13, author: "spock-wen", title: "chore: bump" }),
	];
	const numbers = (query: string) => groupFor(items, "all", query).flatMap((g) => g.items.map((i) => i.number));

	assert.deepEqual(numbers("guard"), [11], "by title");
	assert.deepEqual(numbers("cc-switch"), [12], "by repository");
	assert.deepEqual(numbers("spock"), [13], "by author");
	assert.deepEqual(numbers("#12"), [12], "by number");
});

test("search cannot resurrect a row the filter excluded", () => {
	/*
	 * The order matters: filter first, then search. Searching the whole list and then filtering
	 * would show a pull request under "由我创建" that someone else wrote.
	 */
	const items = [pr({ relation: "reviewing", number: 1, title: "unique-token" }), pr({ relation: "authored", number: 2 })];
	assert.deepEqual(groupFor(items, "authored", "unique-token"), []);
});

test("search is case-insensitive and ignores surrounding space", () => {
	const items = [pr({ relation: "authored", title: "Fix: Guard" })];
	assert.equal(groupFor(items, "all", "  guard ").length, 1);
});
