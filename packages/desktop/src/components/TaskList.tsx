import type { TodoItem } from "@deepwise/core";
import { Check, ChevronDown, ListTodo } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Scroller } from "./Scroller.tsx";
import { ScrollText } from "./ScrollText.tsx";
import { Text } from "./Text.tsx";
import { useApp } from "../store.ts";

/**
 * The agent's plan for the work in hand.
 *
 * A long turn is a wall of tool cards, and the one question it never answers is "how much of
 * this is left". The agent already keeps a list — `todo_write` is how it thinks about work with
 * more than a couple of steps — and until now that list was only visible as one tool card among
 * dozens, immediately buried by the next one.
 *
 * Collapsed it is a single line naming what is happening right now, which is the answer most of
 * the time. Opened it is the whole plan, capped and scrolling, because a plan with forty steps
 * must not push the conversation off the screen.
 */
export function TaskList({ placement }: { placement: "floating" | "inline" }) {
	const todos = useApp((s) => s.todos);
	const [open, setOpen] = useState(false);
	const body = useRef<HTMLDivElement>(null);
	const [height, setHeight] = useState(0);

	const active = todos.find((todo) => todo.status === "in_progress");
	const done = todos.filter((todo) => todo.status === "completed").length;
	const pending = todos.length - done - (active ? 1 : 0);

	/*
	 * Measured, then animated to that measurement.
	 *
	 * `height: auto` cannot be transitioned, and the usual workaround — animating to a max-height
	 * guess — either clips a long list or spends most of the animation covering empty space, so
	 * the movement finishes early and stops dead. Measuring the content each time the list or the
	 * open state changes keeps the motion honest at any length.
	 */
	useEffect(() => {
		const element = body.current;
		if (!element) return;
		const measure = () => setHeight(element.scrollHeight);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [todos, open]);

	if (todos.length === 0) return null;

	return (
		<div
			className={
				placement === "floating"
					? "dw-glass pointer-events-auto w-full overflow-hidden rounded-[11px] border border-line-soft shadow-lg shadow-black/[0.06]"
					: "dw-enter overflow-hidden rounded-[11px] border border-line-soft bg-card/40"
			}
		>
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				className="dw-scroll flex h-9 w-full items-center gap-2 px-3 text-left transition-colors hover:bg-card-hover"
			>
				<ListTodo size={13} strokeWidth={1.8} className="shrink-0 text-ink-faint" />
				{/*
				 * What is happening now, not what the list is called.
				 *
				 * Collapsed, this row is the whole feature for most of a turn — a title saying
				 * "任务" would spend that time telling you something you can see.
				 */}
				<ScrollText
					text={active ? (active.activeForm ?? active.content) : todos.length === done ? "全部完成" : "待开始"}
					className="dw-fade-tail min-w-0 flex-1 text-[12.5px]"
				/>
				<Text size="caption" tone="faint" numeric className="shrink-0">
					{done}/{todos.length}
				</Text>
				<ChevronDown
					size={12.5}
					strokeWidth={1.9}
					className={`shrink-0 text-ink-faint transition-transform duration-200 ${open ? "rotate-180" : ""}`}
				/>
			</button>

			{/*
			 * The list, always mounted so its height is always known.
			 *
			 * Mounting it on open would mean measuring at the moment it becomes visible, which is
			 * one frame too late — the box would jump to its full size and then animate from there.
			 */}
			<div
				style={{ height: open ? height : 0 }}
				className="overflow-hidden transition-[height] duration-200 ease-out"
			>
				<div ref={body} className="border-t border-line-soft">
					<Scroller className="max-h-[min(280px,38vh)]" contentClassName="px-1.5 py-1.5" fadeColor="var(--color-shell)">
						{todos.map((todo, index) => (
							<Row key={`${index}-${todo.content}`} todo={todo} />
						))}
					</Scroller>
				</div>
			</div>

			{!open && pending > 0 && <span className="sr-only">{pending} 项待处理</span>}
		</div>
	);
}

function Row({ todo }: { todo: TodoItem }) {
	return (
		<div className="dw-scroll flex items-center gap-2 rounded-md px-1.5 py-[5px]">
			<Mark status={todo.status} />
			<ScrollText
				text={todo.content}
				className={`dw-fade-tail min-w-0 flex-1 text-[12px] ${
					todo.status === "completed"
						? "text-ink-faint line-through decoration-line"
						: todo.status === "in_progress"
							? "text-ink"
							: "text-ink-muted"
				}`}
			/>
		</div>
	);
}

/**
 * Three states, three marks, all on the same 13px grid so the column of them stays a column.
 *
 * The running one borrows the app's spinner geometry rather than a second kind of spinner, and
 * pending is a dashed ring — present, but plainly not started, which a solid outline reads as.
 */
function Mark({ status }: { status: TodoItem["status"] }) {
	if (status === "completed") {
		return (
			<span className="flex h-[13px] w-[13px] shrink-0 items-center justify-center text-ok">
				<Check size={11} strokeWidth={2.4} />
			</span>
		);
	}
	if (status === "in_progress") {
		return (
			<svg width={13} height={13} viewBox="0 0 24 24" aria-hidden className="dw-spin shrink-0">
				<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3.4" className="text-line" />
				<circle
					cx="12"
					cy="12"
					r="9"
					fill="none"
					stroke="currentColor"
					strokeWidth="3.4"
					strokeLinecap="round"
					strokeDasharray={`${2 * Math.PI * 9 * 0.3} ${2 * Math.PI * 9}`}
					className="text-accent"
				/>
			</svg>
		);
	}
	return (
		<span className="flex h-[13px] w-[13px] shrink-0 items-center justify-center">
			<span className="block h-[9px] w-[9px] rounded-full border border-dashed border-line" />
		</span>
	);
}
