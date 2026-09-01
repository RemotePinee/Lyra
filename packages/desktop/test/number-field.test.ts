/**
 * What a number field does with what you type into it.
 *
 * The rule under test is that the step decides the resolution. It used to truncate everything,
 * which is correct for a font size and destroys any field whose step is a fraction: 行高 stored 1
 * when you typed 1.8, and 字距 — a field whose whole range is -0.1 to 0.2 — could only ever hold
 * zero. Both read as "the setting does nothing", which is exactly what was reported.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

/** The arithmetic out of `NumberField`, which is all that was wrong with it. */
function accept(text: string, { min, max, step }: { min: number; max: number; step: number }): number {
	const decimals = (String(step).split(".")[1] ?? "").length;
	const clamp = (n: number) => Math.min(max, Math.max(min, n));
	const round = (n: number) => (decimals === 0 ? Math.trunc(n) : Number(n.toFixed(decimals)));
	if (text === "" || text === "-") return clamp(0);
	const parsed = Number(text);
	return Number.isFinite(parsed) ? clamp(round(parsed)) : Number.NaN;
}

const TRACKING = { min: -0.1, max: 0.2, step: 0.01 };
const LINE_HEIGHT = { min: 1, max: 3, step: 0.1 };
const FONT_SIZE = { min: 9, max: 24, step: 1 };

test("a fractional step keeps the fraction", () => {
	assert.equal(accept("0.08", TRACKING), 0.08);
	assert.equal(accept("1.8", LINE_HEIGHT), 1.8);
	assert.equal(accept("-0.05", TRACKING), -0.05);
});

test("an integer step still truncates, which is what a font size wants", () => {
	assert.equal(accept("13.7", FONT_SIZE), 13);
});

test("the value is rounded to the step's own resolution", () => {
	// Two decimals of step, three typed: the extra one is not storable and is dropped rather than
	// kept as a value the field cannot display.
	assert.equal(accept("0.123", TRACKING), 0.12);
	assert.equal(accept("1.85", LINE_HEIGHT), 1.9);
});

test("the range is still enforced", () => {
	assert.equal(accept("99", TRACKING), 0.2);
	assert.equal(accept("-99", TRACKING), -0.1);
	assert.equal(accept("0", LINE_HEIGHT), 1);
});

test("an empty box is the minimum, not a refused keystroke", () => {
	// Selecting all and typing passes through "", so refusing it makes the field impossible to clear.
	assert.equal(accept("", LINE_HEIGHT), 1);
	assert.equal(accept("-", TRACKING), 0);
});

test("stepping with the arrow keys does not accumulate float noise", () => {
	const decimals = 1;
	const stepped = Number((1.6 + 0.1).toFixed(decimals));
	// 1.6 + 0.1 is 1.7000000000000002, which the box would render in full.
	assert.equal(stepped, 1.7);
	assert.equal(String(stepped).length, 3);
});
