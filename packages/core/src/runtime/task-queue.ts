/**
 * Work waiting behind whatever is running.
 *
 * Deliberately not the steering queue. Steering splices a message between turns of the current run,
 * which is right for "actually, also check X" and wrong for a dispatched task — that is a separate
 * piece of work and must not blur into the one in progress.
 *
 * The queue owns the list and the draining; it does not know how to run anything. What to do with a
 * task is passed in, which is what keeps this testable without a model and what lets a different
 * scheduler decide the order without touching any of it.
 */

import { randomUUID } from "node:crypto";
import type { QueuedTask } from "../agent/events.ts";
import { nextTask } from "./scheduling.ts";

export interface TaskQueueOptions {
	/** Run one task to completion. Throwing marks it failed. */
	run(task: QueuedTask): Promise<void>;
	/** Whether the session is busy with something that is not a task. */
	busy(): boolean;
	/** Called whenever the list changes, so the UI can be told. */
	changed(): Promise<void>;
	newId(): string;
	now(): number;
}

export class TaskQueue {
	private readonly tasks: QueuedTask[] = [];
	/** Guards the drain loop against the re-entry its own `run` would otherwise cause. */
	private draining = false;

	private readonly options: TaskQueueOptions;

	constructor(options: TaskQueueOptions) {
		this.options = options;
	}

	list(): QueuedTask[] {
		return this.tasks;
	}

	/**
	 * Hand the session a piece of work to run once it is free.
	 *
	 * Runs immediately when nothing is in progress, which is the whole point: you dispatch it and
	 * walk away.
	 */
	async enqueue(text: string, origin: QueuedTask["origin"] = "side-chat"): Promise<QueuedTask> {
		const task: QueuedTask = {
			id: this.options.newId(),
			text,
			origin,
			status: "queued",
			createdAt: this.options.now(),
		};
		this.tasks.push(task);
		await this.options.changed();
		void this.drain();
		return task;
	}

	async cancel(taskId: string): Promise<boolean> {
		const task = this.tasks.find((t) => t.id === taskId);
		if (!task || task.status !== "queued") return false;
		task.status = "cancelled";
		task.finishedAt = this.options.now();
		await this.options.changed();
		return true;
	}

	/**
	 * Stop means stop, including the one in progress.
	 *
	 * A task that has been picked up is cancelled here as well as the ones still waiting: the
	 * button was pressed while it was running, and leaving it to finish is the opposite of what
	 * pressing it asks for. The turn itself is aborted separately, by whoever owns the controller.
	 */
	async cancelAll(): Promise<void> {
		let touched = false;
		for (const task of this.tasks) {
			if (task.status !== "queued" && task.status !== "running") continue;
			task.status = "cancelled";
			task.finishedAt = this.options.now();
			touched = true;
		}
		if (touched) await this.options.changed();
	}

	/** Start draining if nothing else is. Safe to call from anywhere, including mid-drain. */
	async drain(): Promise<void> {
		if (this.draining || this.options.busy()) return;
		this.draining = true;
		try {
			while (true) {
				const next = nextTask(this.tasks);
				if (!next) return;

				next.status = "running";
				next.startedAt = this.options.now();
				await this.options.changed();

				let failure: string | null = null;
				try {
					await this.options.run(next);
				} catch (cause) {
					failure = cause instanceof Error ? cause.message : String(cause);
				}

				/*
				 * Re-read rather than writing to `next` directly.
				 *
				 * `abort` cancels whatever is running and can land at any point during the await
				 * above. Its verdict is the user's; ours is a guess made before the fact.
				 */
				const settled = this.tasks.find((t) => t.id === next.id);
				if (settled?.status === "running") {
					settled.status = failure ? "failed" : "done";
					if (failure) settled.error = failure;
					settled.finishedAt = this.options.now();
				}
				await this.options.changed();
			}
		} finally {
			this.draining = false;
		}
	}
}

/**
 * The queue a session uses, with the two mechanical answers already filled in.
 *
 * Ids and clocks are the queue's business, not the session's — and a caller that had to supply
 * them could supply a clock that goes backwards. What the session does have to say is what running
 * a task means, whether it is busy, and where to send the list when it changes.
 */
export function sessionTaskQueue(deps: {
	run(task: QueuedTask): Promise<void>;
	busy(): boolean;
	/** Given a copy, never the live list: an event holding a reference would report the queue as it
	    looked when someone got round to reading it, not when it was sent. */
	changed(tasks: QueuedTask[]): Promise<void>;
}): TaskQueue {
	const queue: TaskQueue = new TaskQueue({
		run: deps.run,
		busy: deps.busy,
		changed: () => deps.changed(queue.list().map((task) => ({ ...task }))),
		newId: () => randomUUID().slice(0, 8),
		now: () => Date.now(),
	});
	return queue;
}
