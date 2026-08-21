/**
 * What the update badge and dialog show, per phase, as decisions rather than as markup.
 *
 * A download now has six phases and two surfaces drawing them, which is twelve combinations plus
 * the rules about which controls appear in each. Left inline, that is a dozen ternaries spread over
 * two components — readable one at a time and impossible to check as a set, which is exactly how a
 * state ends up with a button that cannot work in it or a percentage that says NaN.
 *
 * So the rules are here, they are pure, and the tests walk every phase through every one of them.
 * The components below this are then only layout: they ask what to show and show it.
 */

import type { UpdatePhase } from "../../electron/ipc-types.ts";

export type Phase = UpdatePhase;

/** Every phase, so a test can walk the whole set rather than the ones somebody remembered. */
export const PHASES: Phase[] = [
	{ at: "idle" },
	{ at: "downloading", received: 45, total: 100 },
	{ at: "paused", received: 45, total: 100 },
	{ at: "preparing", received: 100, total: 100 },
	{ at: "ready", relaunch: true },
	{ at: "failed", error: "下载中断了。", received: 45, total: 100 },
];

/**
 * How far along, 0–1, or null when this phase has no progress to speak of.
 *
 * Null rather than 0 for the phases without one: a ring at zero and no ring at all are different
 * pictures, and `idle` should be the second. Clamped, because a server that sends more than it
 * promised would otherwise push the arc past a full circle and back around.
 */
export function fractionOf(phase: Phase): number | null {
	if (phase.at === "downloading" || phase.at === "paused") {
		// Guarded: `total` is 0 until the first response header lands, and 45/0 is Infinity, which
		// reaches the DOM as a width of `Infinity%` and an arc that vanishes.
		if (!(phase.total > 0)) return 0;
		return Math.min(1, Math.max(0, phase.received / phase.total));
	}
	if (phase.at === "preparing" || phase.at === "ready") return 1;
	return null;
}

/** What the badge says once it opens. Short: it is a label, not a sentence. */
export function labelFor(phase: Phase, version: string): string {
	const percent = Math.round((fractionOf(phase) ?? 0) * 100);
	switch (phase.at) {
		case "downloading":
			return `下载中 ${percent}%`;
		case "paused":
			return `已暂停 ${percent}%`;
		case "preparing":
			return "准备中";
		case "ready":
			return "重启更新";
		case "failed":
			return "下载失败";
		default:
			return `新版本 ${version}`;
	}
}

/** What the dialog's confirming button says. */
export function confirmLabel(phase: Phase): string {
	switch (phase.at) {
		case "downloading":
			return "下载中";
		case "paused":
			return "继续下载";
		case "preparing":
			return "准备中";
		case "ready":
			return "立即重启";
		case "failed":
			return "重试";
		default:
			return "下载安装";
	}
}

/**
 * Which controls the dialog offers in this phase.
 *
 * The rules, stated once:
 *
 *   - `confirm` is disabled only while something is genuinely working. Paused and failed are both
 *     actionable — disabling them was how the old dialog said "wait", which it then never stopped
 *     saying if the download had quietly died.
 *   - `pause` replaces `dismiss` while downloading, rather than joining it: 以后再说 during a
 *     download is an answer to a question nobody is asking any more.
 *   - `cancel` appears only when there is something to throw away. On an untouched update it would
 *     be a second 以后再说 wearing a more alarming word.
 */
export function controlsFor(phase: Phase): {
	confirmDisabled: boolean;
	pause: boolean;
	dismiss: boolean;
	cancel: boolean;
} {
	const running = phase.at === "downloading";
	return {
		confirmDisabled: running || phase.at === "preparing",
		pause: running,
		dismiss: !running,
		cancel: running || phase.at === "paused" || (phase.at === "failed" && phase.received > 0),
	};
}

/**
 * Whether the badge is on screen at all.
 *
 * `dismissed` is 以后再说, which hides the announcement — and should: it answers "there is a new
 * version". It does not answer "you have 90MB of one on disk", so anything mid-flight outranks it.
 * Hiding a running download would leave it using the network with nothing on screen admitting it,
 * which is how someone ends up unable to find the thing they want to stop.
 */
export function shouldShow(
	update: { available: boolean; latest: string } | null,
	dismissed: string | null,
	phase: Phase,
): boolean {
	if (!update?.available) return false;
	if (dismissed !== update.latest) return true;
	return phase.at !== "idle" && phase.at !== "failed";
}

/** Bytes as something a person reads at a glance. One decimal: 90.4MB, not 90.37MB. */
export function mb(bytes: number): string {
	return `${(bytes / 1_048_576).toFixed(1)}MB`;
}
