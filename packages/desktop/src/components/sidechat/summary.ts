/**
 * One line describing work the side chat handed over.
 *
 * Its own file, and not a `.tsx`, so it can be tested: this is a wording rule rather than a piece
 * of rendering, and wording rules are exactly the kind of thing that quietly stops being true.
 */

import type { QueuedTask } from "@deepwise/core";

/**
 * The count matters even while something is running.
 *
 * Saying only "executing" when three more are stacked behind it hides the fact that the session
 * has a backlog — which is exactly what you need to know before dispatching a fourth, or deciding
 * to withdraw one.
 */
export function summarise(active: QueuedTask[]): string {
	const running = active.some((t) => t.status === "running");
	const waiting = active.filter((t) => t.status === "queued").length;
	if (!running) return `${active.length} 个任务在主会话排队`;
	return waiting > 0 ? `正在执行，还有 ${waiting} 个排队` : "主会话正在执行派出的任务";
}
