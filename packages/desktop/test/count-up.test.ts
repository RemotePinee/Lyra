/**
 * The path a rising number takes between two readings.
 *
 * The hook itself needs React to run, so what is tested here is the arithmetic it is built on —
 * which is where the two decisions live: the curve it travels on, and the refusal to travel
 * downwards. Both are claims about what the user sees, and both are wrong in ways that look
 * plausible in code.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

/** The easing the hook uses, and the reason these numbers are not evenly spaced. */
const eased = (progress: number): number => 1 - (1 - progress) ** 3;

/** What the hook renders at a given moment of a journey from `begin` to `target`. */
const at = (begin: number, target: number, progress: number): number =>
	Math.round(begin + (target - begin) * eased(progress));

test("a jump is crossed through the values in between, not skipped", () => {
	// The real case: usage lands per message, so the count goes from nothing to tens of thousands.
	const path = [0, 0.2, 0.4, 0.6, 0.8, 1].map((p) => at(0, 57_100, p));

	assert.equal(path[0], 0, "starts where it was");
	assert.equal(path.at(-1), 57_100, "and ends at the true figure — this animates, it does not round");
	assert.equal(new Set(path).size, path.length, "every sample is a different number");
	assert.deepEqual([...path].sort((a, b) => a - b), path, "and they only ever go up");
});

test("it decelerates: the first half covers more ground than the second", () => {
	/*
	 * This is what makes it read as arriving rather than as a progress bar. A linear tween of a
	 * number is oddly mechanical — it is the settling that says the value has landed.
	 */
	const half = at(0, 1000, 0.5);
	assert.ok(half > 500, `expected past halfway by the midpoint, got ${half}`);
	assert.ok(half < 950, `but not effectively finished, got ${half}`);
});

test("the count never travels downwards through numbers it never had", () => {
	/*
	 * The guard the hook applies before starting: a drop is the turn ending or the session
	 * changing, not the number decreasing. Animating it would show a count-down through figures
	 * that were never real — which says something false about what happened.
	 */
	const dropped = (target: number, from: number) => target <= from;

	assert.equal(dropped(0, 57_100), true, "a reset to zero is not a journey");
	assert.equal(dropped(12_000, 57_100), true, "nor is switching to a smaller conversation");
	assert.equal(dropped(57_200, 57_100), false, "but a hundred more tokens is");
});

test("what is displayed is always the true number once it arrives", () => {
	// The formatting rounds; the target does not. A figure that animates must still be honest at
	// rest, or the count quietly disagrees with the usage it is reporting.
	for (const total of [1, 999, 1000, 57_123, 1_048_576]) {
		assert.equal(at(0, total, 1), total);
	}
});
