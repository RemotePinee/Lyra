import type { QueuedTask } from "../../agent/events.ts";
import type { Context, Plugin } from "../context.ts";
import { SCHEDULER, type TaskScheduler } from "../services.ts";

/**
 * First in, first out.
 *
 * The order the user asked for things is the order they expect them back, and any cleverness here
 * shows up as work being done in an order nobody chose. A scheduler that knows about priority or
 * cost replaces this one; it should not be a flag on it.
 */
class Fifo implements TaskScheduler {
	next(queued: QueuedTask[]): QueuedTask | undefined {
		return queued.find((task) => task.status === "queued");
	}
}

export const schedulerPlugin: Plugin = {
	name: "scheduler",
	apply(ctx: Context) {
		return ctx.provide<TaskScheduler>(SCHEDULER, new Fifo());
	},
};
