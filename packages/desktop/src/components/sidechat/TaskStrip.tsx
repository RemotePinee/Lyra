/**
 * What the side chat has handed over, and where it got to.
 *
 * The side chat cannot act on the project itself, so anything that needs doing is dispatched to
 * the main session's queue. This is the receipt for that.
 *
 * Collapsed to one line by default. The interesting fact is almost always just "something is
 * queued"; the list matters only when you want to withdraw one.
 */

import type { QueuedTask } from "@deepwise/core";
import { Ban, Check, ChevronDown, CircleDashed, Clock, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useSide } from "../../sideStore.ts";

const TASK_ICON: Record<QueuedTask["status"], typeof Clock> = {
	queued: Clock,
	running: CircleDashed,
	done: Check,
	failed: TriangleAlert,
	cancelled: Ban,
};

const TASK_LABEL: Record<QueuedTask["status"], string> = {
	queued: "排队中",
	running: "执行中",
	done: "已完成",
	failed: "失败",
	cancelled: "已取消",
};

/** Finished tasks linger this many rows, so a card does not vanish the instant it completes. */
const RECENT_KEPT = 3;

export function TaskStrip() {
	const tasks = useSide((s) => s.tasks);
	const [open, setOpen] = useState(false);

	const active = tasks.filter((t) => t.status === "queued" || t.status === "running");
	const recent = tasks.filter((t) => t.status !== "queued" && t.status !== "running").slice(-RECENT_KEPT);
	const shown = open ? [...recent, ...active] : active;

	// Nothing dispatched, nothing to say.
	useEffect(() => {
		if (active.length === 0) setOpen(false);
	}, [active.length]);

	if (active.length === 0) return null;

	return (
		// The rule spans the panel because it separates two regions; what sits on it lines up
		// with the conversation, so the strip does not drift away from the messages full screen.
		<div className="shrink-0 border-t border-line">
			<div className="mx-auto w-full max-w-[var(--dw-content)] px-2 pt-2">
				<button
					type="button"
					onClick={() => setOpen((v) => !v)}
					aria-expanded={open}
					className="dw-item flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-[12px]"
				>
					{active.some((t) => t.status === "running") ? (
						<CircleDashed size={12.5} strokeWidth={1.9} className="dw-spin shrink-0 text-ink-muted" />
					) : (
						<Clock size={12.5} strokeWidth={1.9} className="shrink-0 text-ink-muted" />
					)}
					<span className="min-w-0 flex-1 truncate">{summarise(active)}</span>
					<ChevronDown
						size={12}
						strokeWidth={2}
						className="shrink-0 text-ink-faint transition-transform duration-200"
						style={open ? { transform: "rotate(180deg)" } : undefined}
					/>
				</button>

				{open && (
					<div className="flex max-h-[180px] flex-col gap-1 overflow-y-auto pt-1 pb-1">
						{shown.map((task) => (
							<TaskRow key={task.id} task={task} />
						))}
					</div>
				)}
			</div>
		</div>
	);
}

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

function TaskRow({ task }: { task: QueuedTask }) {
	const cancelTask = useSide((s) => s.cancelTask);
	const Icon = TASK_ICON[task.status];

	return (
		<div className="flex items-start gap-2 rounded-lg border border-line-soft px-2 py-1.5 text-[12px]">
			<Icon
				size={12.5}
				strokeWidth={1.9}
				className={`mt-[3px] shrink-0 ${
					task.status === "failed"
						? "text-danger"
						: task.status === "done"
							? "text-ok"
							: task.status === "running"
								? "dw-spin text-ink-muted"
								: "text-ink-faint"
				}`}
			/>
			<div className="min-w-0 flex-1">
				<p className="line-clamp-3 leading-relaxed text-ink-muted">{task.text}</p>
				<p className="pt-0.5 text-[11px] text-ink-faint">
					{TASK_LABEL[task.status]}
					{task.error ? ` · ${task.error}` : ""}
				</p>
			</div>
			{task.status === "queued" && (
				<button
					type="button"
					data-dw-tip="撤回这个任务"
					onClick={() => void cancelTask(task.id)}
					className="shrink-0 rounded-md px-1.5 py-0.5 text-[11.5px] text-ink-faint transition-colors hover:bg-card-hover hover:text-ink"
				>
					撤回
				</button>
			)}
		</div>
	);
}
