/**
 * Every phase of an update, through every rule that draws it.
 *
 * The point of these is coverage of the *set*, not of any one case. A download has six phases and
 * two surfaces showing them, and the failures that actually happen are the combinations nobody
 * pictured: a percentage computed before the first response header arrives (45/0 → `Infinity%`),
 * a 继续 button greyed out in the one phase where continuing is the entire point, a 取消 offered
 * for a download that has not started. None of those is visible when reading one ternary; all of
 * them are visible when you walk the phases in a row.
 *
 * So `PHASES` is exported from the module under test rather than written out here — a phase added
 * later joins these tests automatically, instead of being the one nobody remembered to add.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	confirmLabel,
	controlsFor,
	fractionOf,
	labelFor,
	mb,
	PHASES,
	shouldShow,
	type Phase,
} from "../src/update/view.ts";

const update = { available: true, latest: "0.3.2" };

test("every phase has a label, and none of them says NaN or undefined", () => {
	for (const phase of PHASES) {
		const label = labelFor(phase, "0.3.2");
		assert.ok(label.length > 0, `${phase.at} 没有文案`);
		assert.doesNotMatch(label, /NaN|undefined|Infinity/, `${phase.at} 的文案是：${label}`);
	}
});

test("every phase has a confirm label, and none of them is empty", () => {
	for (const phase of PHASES) {
		assert.ok(confirmLabel(phase).length > 0, `${phase.at} 的主按钮没有文案`);
	}
});

test("a fraction is either absent or a real number between 0 and 1", () => {
	for (const phase of PHASES) {
		const fraction = fractionOf(phase);
		if (fraction === null) continue;
		assert.ok(Number.isFinite(fraction), `${phase.at} 的进度不是有限数：${fraction}`);
		assert.ok(fraction >= 0 && fraction <= 1, `${phase.at} 的进度越界：${fraction}`);
	}
});

test("a total of zero is nought percent, not a division by zero", () => {
	/*
	 * The first `downloading` event fires before any response header has landed, so `total` is 0 and
	 * `received` may already be positive. `45/0` is `Infinity`, which reaches the DOM as
	 * `width: Infinity%` and an arc that disappears — a badge that breaks in the first frame of
	 * every download and is fixed by the second.
	 */
	assert.equal(fractionOf({ at: "downloading", received: 45, total: 0 }), 0);
	assert.equal(fractionOf({ at: "paused", received: 45, total: 0 }), 0);
});

test("a server that sends more than it promised does not overrun the ring", () => {
	assert.equal(fractionOf({ at: "downloading", received: 120, total: 100 }), 1);
});

test("idle and failed have no progress; the finished phases are full", () => {
	assert.equal(fractionOf({ at: "idle" }), null, "没开始就不该画进度环");
	assert.equal(fractionOf({ at: "failed", error: "x", received: 0, total: 0 }), null);
	assert.equal(fractionOf({ at: "preparing", received: 1, total: 1 }), 1);
	assert.equal(fractionOf({ at: "ready", relaunch: true }), 1);
});

test("the label carries the percentage while it is moving and while it is not", () => {
	assert.equal(labelFor({ at: "downloading", received: 45, total: 100 }, "0.3.2"), "下载中 45%");
	assert.equal(labelFor({ at: "paused", received: 45, total: 100 }, "0.3.2"), "已暂停 45%");
});

test("idle names the version, because that is the announcement", () => {
	assert.equal(labelFor({ at: "idle" }, "0.3.2"), "新版本 0.3.2");
});

/*
 * The controls. One test per rule, stated as the rule rather than as the phases it happens to
 * cover — the phases are walked in the round-trip test below.
 */

test("the confirm button is disabled only while something is genuinely working", () => {
	for (const phase of PHASES) {
		const { confirmDisabled } = controlsFor(phase);
		const working = phase.at === "downloading" || phase.at === "preparing";
		assert.equal(confirmDisabled, working, `${phase.at} 的主按钮可用性不对`);
	}
});

test("paused offers a way to continue, which is the whole reason to allow pausing", () => {
	const paused: Phase = { at: "paused", received: 45, total: 100 };
	assert.equal(controlsFor(paused).confirmDisabled, false);
	assert.equal(confirmLabel(paused), "继续下载");
});

test("a failure offers a retry, and it is not greyed out", () => {
	const failed: Phase = { at: "failed", error: "下载中断了。", received: 45, total: 100 };
	assert.equal(controlsFor(failed).confirmDisabled, false);
	assert.equal(confirmLabel(failed), "重试");
});

test("暂停 and 以后再说 never appear together, and one of them always does", () => {
	/*
	 * They occupy the same slot: during a download 以后再说 answers a question nobody is asking any
	 * more, and outside one 暂停 has nothing to stop. Both at once would be two buttons for one
	 * position; neither would leave a gap where a control belongs.
	 */
	for (const phase of PHASES) {
		const { pause, dismiss } = controlsFor(phase);
		assert.notEqual(pause, dismiss, `${phase.at} 的这两个按钮应当恰好出现一个`);
	}
});

test("取消 is offered only when there is something to throw away", () => {
	assert.equal(controlsFor({ at: "idle" }).cancel, false, "还没开始，没有东西可取消");
	assert.equal(controlsFor({ at: "downloading", received: 1, total: 2 }).cancel, true);
	assert.equal(controlsFor({ at: "paused", received: 1, total: 2 }).cancel, true);
	assert.equal(controlsFor({ at: "failed", error: "x", received: 5, total: 9 }).cancel, true, "有碎片就能清掉");
	assert.equal(controlsFor({ at: "failed", error: "x", received: 0, total: 9 }).cancel, false, "没下到东西就没得取消");
});

test("取消 is not offered once it is downloaded and waiting on a restart", () => {
	// There is nothing left to cancel: the bytes are unpacked and the old app is still running.
	assert.equal(controlsFor({ at: "ready", relaunch: true }).cancel, false);
});

/* Whether the badge is on screen at all. */

test("no update means no badge, whatever else is true", () => {
	for (const phase of PHASES) {
		assert.equal(shouldShow({ available: false, latest: "0.3.2" }, null, phase), false);
		assert.equal(shouldShow(null, null, phase), false);
	}
});

test("an available update shows, until it is dismissed", () => {
	assert.equal(shouldShow(update, null, { at: "idle" }), true);
	assert.equal(shouldShow(update, "0.3.2", { at: "idle" }), false);
});

test("dismissing one version does not hide the next", () => {
	assert.equal(shouldShow(update, "0.3.1", { at: "idle" }), true);
});

test("a download in flight outranks having been dismissed", () => {
	/*
	 * 以后再说 answers "there is a new version". It does not answer "you have 90MB of one coming
	 * down" — and hiding that would leave a download using the network with nothing on screen
	 * admitting it, so the only way to stop it would be to quit the app.
	 */
	assert.equal(shouldShow(update, "0.3.2", { at: "downloading", received: 1, total: 2 }), true);
	assert.equal(shouldShow(update, "0.3.2", { at: "paused", received: 1, total: 2 }), true);
	assert.equal(shouldShow(update, "0.3.2", { at: "preparing", received: 2, total: 2 }), true);
	assert.equal(shouldShow(update, "0.3.2", { at: "ready", relaunch: true }), true);
});

test("a failed download that was dismissed stays hidden", () => {
	// Nothing is running and the announcement was answered; re-raising it would be nagging.
	assert.equal(shouldShow(update, "0.3.2", { at: "failed", error: "x", received: 0, total: 0 }), false);
});

test("bytes are rendered as something a person reads", () => {
	assert.equal(mb(0), "0.0MB");
	assert.equal(mb(1_048_576), "1.0MB");
	assert.equal(mb(141_557_760), "135.0MB");
});
