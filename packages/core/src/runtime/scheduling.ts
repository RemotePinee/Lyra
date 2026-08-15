/**
 * Which scheduler the session drains its queue with.
 *
 * Bound by the host at boot, as with the other seams; unbound, the queue runs in the order it was
 * filled, which is what a person sitting in front of it expects.
 */

import type { QueuedTask } from "../agent/events.ts";
import type { TaskScheduler } from "../kernel/services.ts";

let bound: TaskScheduler | null = null;

export function useScheduler(next: TaskScheduler | null): void {
	bound = next;
}

export function nextTask(queued: QueuedTask[]): QueuedTask | undefined {
	if (bound) return bound.next(queued);
	return queued.find((task) => task.status === "queued");
}
