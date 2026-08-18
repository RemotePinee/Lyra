/**
 * What the panel's two transitions are allowed to move.
 *
 * The complaint these guard was "退出全屏的动画太难看了，闪烁" — and the flicker was not in the
 * panel at all. It was the conversation behind it re-laying itself out in a single frame because
 * the row stopped reserving its width the moment full screen was asked for, a fifth of a second
 * before the panel had covered the strip where that reflow was visible.
 *
 * Nothing in a type check or a screenshot of either end state catches that, so it is stated here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { paneWidth, rowReserve } from "../src/pane-geometry.ts";

const beside = { open: true, compact: false, fullScreen: false, reserved: 553, width: 853, offset: 359 };

test("full screen does not change what the row reserves", () => {
	assert.equal(rowReserve(beside), rowReserve({ ...beside, fullScreen: true }));
	// Said as the fact it stands for: the column keeps the width it was laid out at.
	assert.equal(rowReserve({ ...beside, fullScreen: true }), 553);
});

test("closing gives the width back; compact never took any", () => {
	assert.equal(rowReserve({ ...beside, open: false }), 0);
	assert.equal(rowReserve({ ...beside, compact: true }), 0, "a drawer lies over the whole window");
	assert.equal(rowReserve({ ...beside, compact: true, fullScreen: true }), 0);
});

test("the drawn width is one property in both forms, so the two can interpolate", () => {
	assert.equal(paneWidth(beside), "853px");
	assert.equal(paneWidth({ ...beside, fullScreen: true }), "calc(100% - 359px)");
	// With the navigation away there is nothing to stop short of.
	assert.equal(paneWidth({ ...beside, fullScreen: true, offset: 0 }), "calc(100% - 0px)");
});

test("compact wins over full screen — a drawer is already the whole window", () => {
	assert.equal(paneWidth({ ...beside, compact: true, fullScreen: true }), "100%");
	assert.equal(paneWidth({ ...beside, compact: true }), "100%");
});

test("a closed panel is drawn at the width it will have, not at nothing", () => {
	/*
	 * It slides out; it does not shrink. This is the same mistake the sidebar was making — handed a
	 * width of zero it had nothing to translate, so `marginLeft: -0` moved it nowhere and it simply
	 * stopped existing between one frame and the next.
	 */
	assert.equal(paneWidth({ ...beside, open: false } as typeof beside), "853px");
});
