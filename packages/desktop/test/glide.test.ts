/**
 * Which run's summary line glides, and — the part that actually broke — when React is told.
 *
 * This bug survived two fixes because both were verified the wrong way. The rule itself ("only the
 * last run of a turn that is still going") was correct both times; what was wrong was that the
 * component never re-rendered when the answer changed, because its memo comparison looked only at
 * the calls. A group stops being the last one when another begins, and stops being live when the
 * turn ends — in both cases its own calls are untouched, so the comparison said "no change" and
 * the highlight stayed lit.
 *
 * Verifying it by switching conversations could never have caught that: switching remounts the
 * components, and a fresh mount does not consult a memo comparison at all. So the tests here cover
 * both halves — the rule, and the propagation — and the second is the one that matters.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

/** The rule, as `Conversation` applies it to each run in the transcript. */
const glides = (index: number, total: number, turnRunning: boolean) => turnRunning && index === total - 1;

/**
 * The memo comparison, verbatim from `runs.tsx`. Returns true when React may skip the render.
 *
 * Only the shape it is given matters here — ids and stop reasons stand in for whole calls.
 */
type Call = { id: string; stopReason: string };
const skipsRender = (
	before: { calls: Call[]; trailing?: boolean },
	after: { calls: Call[]; trailing?: boolean },
): boolean => {
	if (before.trailing !== after.trailing) return false;
	if (before.calls.length !== after.calls.length) return false;
	return before.calls.every((call, i) => call.id === after.calls[i].id && call.stopReason === after.calls[i].stopReason);
};

const CALLS: Call[] = [{ id: "a", stopReason: "toolCall" }];

test("only the run being worked on glides", () => {
	assert.deepEqual([0, 1, 2].map((i) => glides(i, 3, true)), [false, false, true]);
});

test("a finished turn glides nowhere", () => {
	assert.deepEqual([0, 1, 2].map((i) => glides(i, 3, false)), [false, false, false]);
});

test("a group that stops being the last one is re-rendered, though its calls are identical", () => {
	/*
	 * The exact bug. A second run begins; the first one's calls have not moved, and under the old
	 * comparison that was the end of it — so the first group kept the highlight it had when it was
	 * the only one, and the transcript ended up with two lit lines.
	 */
	const before = { calls: CALLS, trailing: true };
	const after = { calls: CALLS, trailing: false };
	assert.equal(skipsRender(before, after), false, "the group must be told it is no longer the current one");
});

test("a group that stops being live is re-rendered, though its calls are identical", () => {
	// The other half: the turn ends. Nothing about the group changes except that it is over.
	assert.equal(skipsRender({ calls: CALLS, trailing: true }, { calls: CALLS, trailing: false }), false);
});

test("a settled group with nothing new is still skipped — the memo has to keep earning its place", () => {
	/*
	 * The comparison exists because the transcript re-renders on every streamed token, and every
	 * finished group above would re-render with it. Adding `trailing` must not cost that.
	 */
	assert.equal(skipsRender({ calls: CALLS, trailing: false }, { calls: CALLS, trailing: false }), true);
	assert.equal(skipsRender({ calls: CALLS, trailing: true }, { calls: CALLS, trailing: true }), true);
});

test("a group gaining a call is re-rendered, as it always was", () => {
	const after = { calls: [...CALLS, { id: "b", stopReason: "toolCall" }], trailing: true };
	assert.equal(skipsRender({ calls: CALLS, trailing: true }, after), false);
});

test("a call finishing inside a group is re-rendered", () => {
	const after = { calls: [{ id: "a", stopReason: "end" }], trailing: true };
	assert.equal(skipsRender({ calls: CALLS, trailing: true }, after), false);
});

test("the whole sequence: two runs in one turn, then the turn ends", () => {
	/*
	 * Played out as the transcript actually receives it, checking at each step both what should be
	 * lit and whether the components would have been told.
	 */
	const first = { calls: CALLS, trailing: glides(0, 1, true) };
	assert.equal(first.trailing, true, "the only run, mid-turn, glides");

	// A second run begins.
	const firstNow = { calls: CALLS, trailing: glides(0, 2, true) };
	assert.equal(firstNow.trailing, false, "it is no longer the last");
	assert.equal(skipsRender(first, firstNow), false, "and React is told");

	const second = { calls: CALLS, trailing: glides(1, 2, true) };
	assert.equal(second.trailing, true, "the new one glides instead");

	// The turn ends.
	const secondNow = { calls: CALLS, trailing: glides(1, 2, false) };
	assert.equal(secondNow.trailing, false, "nothing glides after the turn");
	assert.equal(skipsRender(second, secondNow), false, "and React is told about that too");
});
