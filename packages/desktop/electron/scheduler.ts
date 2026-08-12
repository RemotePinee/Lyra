/**
 * Scheduled tasks.
 *
 * Each due task starts a *fresh* session and sends its prompt. A fresh session is deliberate:
 * a recurring task that accumulated history would drift as the transcript grew, and would
 * eventually blow past the context window.
 *
 * The tick is one minute, which is the finest granularity the schedule kinds express.
 */

import type { AgentSession, ScheduledTask, Settings } from "@deepwise/core";

const TICK_MS = 60_000;

export interface SchedulerDeps {
	getSettings(): Settings;
	saveSettings(settings: Settings): Promise<void>;
	createSession(cwd: string, modelId: string): Promise<AgentSession>;
	notify(message: string, level: "info" | "warn" | "error"): void;
}

export class Scheduler {
	private deps: SchedulerDeps;
	private timer: ReturnType<typeof setInterval> | null = null;
	/** Guards against a slow task being started twice by successive ticks. */
	private running = new Set<string>();

	constructor(deps: SchedulerDeps) {
		this.deps = deps;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), TICK_MS);
		// Run one tick shortly after launch so a task overdue from last session fires.
		setTimeout(() => void this.tick(), 5_000);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	async tick(now = Date.now()): Promise<void> {
		const settings = this.deps.getSettings();
		for (const task of settings.scheduledTasks) {
			if (!task.enabled || this.running.has(task.id)) continue;
			if (!isDue(task, now)) continue;
			await this.run(task, now);
		}
	}

	private async run(task: ScheduledTask, now: number): Promise<void> {
		this.running.add(task.id);
		let sessionId: string | undefined;
		let error: string | undefined;

		try {
			const settings = this.deps.getSettings();
			const session = await this.deps.createSession(task.cwd, settings.defaultModelId ?? "");
			sessionId = session.meta.id;
			this.deps.notify(`已安排任务「${task.name}」开始运行`, "info");
			// Not awaited: the turn can run for minutes and must not block the tick.
			void session.prompt([{ type: "text", text: task.prompt }]).catch((cause: unknown) => {
				this.deps.notify(
					`已安排任务「${task.name}」失败：${cause instanceof Error ? cause.message : String(cause)}`,
					"error",
				);
			});
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
			this.deps.notify(`已安排任务「${task.name}」无法启动：${error}`, "error");
		} finally {
			this.running.delete(task.id);
			// Record the attempt either way, so a failing task does not retry every minute.
			const settings = this.deps.getSettings();
			await this.deps.saveSettings({
				...settings,
				scheduledTasks: settings.scheduledTasks.map((t) =>
					t.id === task.id ? { ...t, lastRunAt: now, lastSessionId: sessionId, lastError: error } : t,
				),
			});
		}
	}
}

export function isDue(task: ScheduledTask, now: number): boolean {
	if (task.schedule.kind === "interval") {
		const period = Math.max(1, task.schedule.minutes) * 60_000;
		return task.lastRunAt === undefined || now - task.lastRunAt >= period;
	}

	const [hours, minutes] = task.schedule.time.split(":").map(Number);
	if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return false;

	const today = new Date(now);
	const target = new Date(now);
	target.setHours(hours, minutes, 0, 0);
	if (now < target.getTime()) return false;

	// Already ran today?
	if (task.lastRunAt === undefined) return true;
	const last = new Date(task.lastRunAt);
	return (
		last.getFullYear() !== today.getFullYear() ||
		last.getMonth() !== today.getMonth() ||
		last.getDate() !== today.getDate()
	);
}

/** When the task will next fire, for display. */
export function nextRunAt(task: ScheduledTask, now = Date.now()): number | null {
	if (!task.enabled) return null;
	if (task.schedule.kind === "interval") {
		const period = Math.max(1, task.schedule.minutes) * 60_000;
		return task.lastRunAt === undefined ? now : task.lastRunAt + period;
	}
	const [hours, minutes] = task.schedule.time.split(":").map(Number);
	if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
	const target = new Date(now);
	target.setHours(hours, minutes, 0, 0);
	if (target.getTime() <= now || (task.lastRunAt && sameDay(task.lastRunAt, now))) {
		target.setDate(target.getDate() + 1);
	}
	return target.getTime();
}

function sameDay(a: number, b: number): boolean {
	const x = new Date(a);
	const y = new Date(b);
	return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}
