/**
 * How deep the sidebar's pinned rows reach.
 *
 * The rows are held by `position: sticky` and need no arithmetic — the browser does that on the
 * compositor, which is the only way they keep up with a wheel. All that is left for JavaScript is
 * where the *bottom* of the pinned band is, so the scroller's fade starts under the rows rather
 * than through them, and these are the cases that number gets wrong.
 *
 * Numbers are viewport-relative pixels, the way `getBoundingClientRect` reports them once the
 * viewport's own top is subtracted: negative means scrolled past.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { pinnedDepth, type StickyRow } from "../src/components/sidebar/sticky.ts";

const GAP = 6;
const STRIP = 32;
/** Where headings rest: a gap, the strip, and a gap again. */
const RAIL = GAP + STRIP + GAP;
const HEAD = 31;

const strip = (top: number): StickyRow => ({ top, bottom: top + STRIP, rail: GAP });
const head = (top: number): StickyRow => ({ top, bottom: top + HEAD, rail: RAIL });

test("nothing is covered before the list has scrolled", () => {
	// The strip is still down the pane where the list puts it, and the first heading below that.
	assert.equal(pinnedDepth([strip(120), head(160), head(400)]), 0);
});

test("a strip that has reached its rail covers down to its own underside", () => {
	assert.equal(pinnedDepth([strip(GAP), head(300)]), GAP + STRIP);
});

test("a heading held under the strip is what the depth follows", () => {
	const depth = pinnedDepth([strip(GAP), head(RAIL), head(600)]);
	/*
	 * The assertion the fade depends on. A pinned row is opaque, so the list behind it is hidden
	 * either way — but the rows *below* it must not start softening until they are clear of it, or
	 * the first conversation under a project name is half drawn.
	 */
	assert.equal(depth, RAIL + HEAD);
});

test("a heading on its way out still covers what it is standing on", () => {
	// Pushed above its rail by the next one, but still on screen and still opaque.
	const depth = pinnedDepth([strip(GAP), head(RAIL - 12), head(RAIL + HEAD - 12)]);
	assert.equal(depth, RAIL + HEAD - 12, "the depth follows it up rather than staying where it was");
});

test("a heading still arriving covers nothing", () => {
	// One pixel short of its rail: the list is still carrying it, so it is part of the list.
	const depth = pinnedDepth([strip(GAP), head(RAIL + 1)]);
	assert.equal(depth, GAP + STRIP, "the strip's depth, with nothing added for a row still in transit");
});

test("a heading resting exactly on its rail counts", () => {
	// `<=` rather than `<`, and the reason is subpixel scroll positions: these are two floats that
	// agree in every way that matters until the ninth decimal.
	assert.ok(Math.abs(pinnedDepth([strip(GAP), head(RAIL + 0.0000001)]) - (RAIL + HEAD)) < 0.001);
});

test("the lowest held row wins, whatever order they arrive in", () => {
	const rows = [head(RAIL - 20), strip(GAP), head(RAIL)];
	assert.equal(pinnedDepth(rows), RAIL + HEAD, "an outgoing heading above the rail does not shorten the band");
});

test("a list with no headings is just the strip", () => {
	assert.equal(pinnedDepth([strip(GAP)]), GAP + STRIP);
	assert.equal(pinnedDepth([]), 0);
});
