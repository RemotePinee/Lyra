/**
 * When a scheduled task is due, and when it will next fire.
 *
 * Two answers to the same question, and they have to agree: the scheduler decides whether to run
 * something *now*, the list tells you when it will run *next*. Written apart, in two processes,
 * they drift — the badge says 09:00 and the run happens at 09:05, and nobody can tell which of the
 * two is wrong.
 *
 * Pure, and in core rather than in the main process, so both ends compute it from the same rules.
 */

import type { ScheduledTask } from "./settings.ts";

/** Whether the task should run at `now`. */
export function isDue(task: ScheduledTask, now: number): boolean {
	if (task.schedule.kind === "interval") {
		const period = Math.max(1, task.schedule.minutes) * 60_000;
		return task.lastRunAt === undefined || now - task.lastRunAt >= period;
	}

	const at = timeOfDay(task.schedule.time);
	if (!at) return false;

	const target = new Date(now);
	target.setHours(at.hours, at.minutes, 0, 0);
	if (now < target.getTime()) return false;

	// A daily task fires once a day, however long the app has been open.
	return task.lastRunAt === undefined || !sameDay(task.lastRunAt, now);
}

/** When it will next fire, or null if it never will. For display. */
export function nextRunAt(task: ScheduledTask, now = Date.now()): number | null {
	if (!task.enabled) return null;

	if (task.schedule.kind === "interval") {
		const period = Math.max(1, task.schedule.minutes) * 60_000;
		return task.lastRunAt === undefined ? now : task.lastRunAt + period;
	}

	const at = timeOfDay(task.schedule.time);
	if (!at) return null;

	const target = new Date(now);
	target.setHours(at.hours, at.minutes, 0, 0);
	// Today's slot has passed, or was already used today.
	if (target.getTime() <= now || (task.lastRunAt !== undefined && sameDay(task.lastRunAt, now))) {
		target.setDate(target.getDate() + 1);
	}
	return target.getTime();
}

/** `"09:30"` → hours and minutes, or null if it is not a time at all. */
function timeOfDay(value: string): { hours: number; minutes: number } | null {
	const [hours, minutes] = value.split(":").map(Number);
	if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
	return { hours, minutes };
}

function sameDay(a: number, b: number): boolean {
	const x = new Date(a);
	const y = new Date(b);
	return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}
