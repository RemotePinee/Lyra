/**
 * Where a surface goes when the space it was aimed at is too small.
 *
 * A right-click low in a file tree opens a menu taller than the space beneath the cursor, and
 * often taller than the space above it too. The answer to that is not a scrollbar in a list of
 * eleven actions — it is to move the menu up until it fits, which is what every native menu does.
 * Scrolling hid the items at the end, which for the file menu are the destructive ones, behind a
 * gesture nobody thinks to try.
 *
 * The arithmetic from `Popover`, so the decision can be checked at sizes that are awkward to
 * reproduce by hand.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const GAP = 8;
const MARGIN = 12;

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** Where the surface is placed, and what its height is capped at. */
function place(options: { anchorTop: number; anchorBottom: number; height: number; windowHeight: number }) {
	const { anchorTop, anchorBottom, height, windowHeight } = options;
	const fitsAbove = anchorTop - height - GAP >= MARGIN;
	const fitsBelow = anchorBottom + height + GAP <= windowHeight - MARGIN;
	const resolved = fitsBelow || !fitsAbove ? "bottom" : "top";
	const shifted = !fitsAbove && !fitsBelow && height + MARGIN * 2 <= windowHeight;

	const top = shifted
		? clamp(anchorBottom + GAP, MARGIN, windowHeight - height - MARGIN)
		: resolved === "bottom"
			? anchorBottom + GAP
			: null;
	const maxHeight = shifted
		? windowHeight - MARGIN * 2
		: resolved === "bottom"
			? windowHeight - anchorBottom - GAP - MARGIN
			: anchorTop - GAP - MARGIN;

	return { resolved, shifted, top, maxHeight, scrolls: height > maxHeight };
}

test("with room below, the menu hangs off the cursor as it always did", () => {
	const at = place({ anchorTop: 100, anchorBottom: 100, height: 300, windowHeight: 900 });
	assert.equal(at.shifted, false);
	assert.equal(at.resolved, "bottom");
	assert.equal(at.top, 108, "just under the cursor");
	assert.equal(at.scrolls, false);
});

test("with room only above, it flips — no shifting needed", () => {
	const at = place({ anchorTop: 700, anchorBottom: 700, height: 300, windowHeight: 900 });
	assert.equal(at.shifted, false);
	assert.equal(at.resolved, "top");
	assert.equal(at.scrolls, false);
});

test("with room on neither side, it slides into the window instead of scrolling", () => {
	/*
	 * A tall menu in a short window: 600px of actions, cursor at 400 in an 800px window. There is
	 * 392 below and 400 above — the menu fits in neither, but fits in the window with room to
	 * spare, which is exactly the case a scrollbar was the wrong answer to.
	 */
	const at = place({ anchorTop: 400, anchorBottom: 400, height: 600, windowHeight: 800 });
	assert.equal(at.shifted, true, "placed by fitting rather than by hanging off the cursor");
	assert.equal(at.scrolls, false, "and so the whole menu is readable");
	assert.equal(at.top, 188, "moved up by exactly enough");
	assert.equal(at.top + 600, 788, "which is one margin clear of the bottom");
});

test("wherever the cursor is, a shifted menu lands inside the window", () => {
	/*
	 * Swept rather than sampled, because the interesting cases are the ones that are awkward to
	 * pick by hand: with a menu this tall relative to the window, whether either side has room
	 * changes over a narrow band of cursor positions, and the shift only happens inside it.
	 */
	const windowHeight = 700;
	const height = 600;
	let shifts = 0;

	for (let cursor = 0; cursor <= windowHeight; cursor += 10) {
		const at = place({ anchorTop: cursor, anchorBottom: cursor, height, windowHeight });
		if (!at.shifted) continue;
		shifts++;
		assert.ok(at.top !== null && at.top >= MARGIN, `cursor ${cursor}: top ${at.top} is above the window`);
		assert.ok(at.top !== null && at.top + height <= windowHeight - MARGIN, `cursor ${cursor}: bottom is past the edge`);
		assert.equal(at.scrolls, false, `cursor ${cursor}: shifted menus should not need a scrollbar`);
	}

	assert.ok(shifts > 0, "the sweep should have found the band where neither side fits");
});

test("a menu taller than the window scrolls, because there is nothing else to do", () => {
	/*
	 * The one case where scrolling is right. Shifting is refused rather than attempted, so the
	 * surface stays anchored to the cursor and the scroll is inside a menu that genuinely cannot
	 * be shown whole.
	 */
	const at = place({ anchorTop: 400, anchorBottom: 400, height: 1400, windowHeight: 900 });
	assert.equal(at.shifted, false, "a menu that cannot fit is not moved around pretending it might");
	assert.equal(at.scrolls, true);
});

test("the shift never makes the menu shorter than it would have been", () => {
	// The ceiling has to lift with the placement, or moving it up would gain nothing.
	const stuck = place({ anchorTop: 400, anchorBottom: 400, height: 600, windowHeight: 800 });
	const gapBelow = 800 - 400 - GAP - MARGIN;
	assert.ok(stuck.maxHeight > gapBelow, `${stuck.maxHeight} should exceed the ${gapBelow} it started with`);
});
