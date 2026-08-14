import { Check, ListTodo } from "lucide-react";

import { PanelEmpty } from "./PanelEmpty.tsx";
import { Scroller } from "./Scroller.tsx";
import { ScrollText } from "./ScrollText.tsx";
import { Text } from "./Text.tsx";
import { useApp } from "../store.ts";

/**
 * Everything this conversation set out to do and everything it actually did.
 *
 * The card floating over the transcript answers "what now" and puts itself away when the plan is
 * finished — which is right for a heads-up display and wrong for going back over the work. This
 * is the other question: what was the plan, which parts got done, and what was run along the way.
 *
 * Both halves are already in the conversation — the plan on the tool call that wrote it, the runs
 * on their cards — but scattered through a transcript that may be hundreds of messages long. The
 * value here is entirely in having them in one column, in order.
 */
export function TaskPanel() {
	const todos = useApp((s) => s.todos);
	const toolRuns = useApp((s) => s.toolRuns);
	const running = useApp((s) => s.running);

	// Newest first: what just happened is what you came to look at.
	const runs = Object.values(toolRuns).sort((a, b) => b.startedAt - a.startedAt);
	const done = todos.filter((todo) => todo.status === "completed").length;

	if (todos.length === 0 && runs.length === 0) {
		return (
			<PanelEmpty icon={ListTodo} title="任务">
				这个对话还没有执行过任何操作。
			</PanelEmpty>
		);
	}

	return (
		<Scroller className="flex-1" contentClassName="px-2 pb-3" fade={false}>
			{todos.length > 0 && (
				<>
					<Header label="计划" hint={`${done}/${todos.length}`} />
					{todos.map((todo, index) => (
						<div key={`${index}-${todo.content}`} className="dw-scroll flex items-center gap-2 rounded-md px-1.5 py-[5px]">
							<span className="flex h-[13px] w-[13px] shrink-0 items-center justify-center">
								{todo.status === "completed" ? (
									<Check size={11} strokeWidth={2.4} className="text-ok" />
								) : todo.status === "in_progress" ? (
									// Paused whenever no turn is running: motion belongs to the turn, not the plan.
									<span className={`block h-[7px] w-[7px] rounded-full ${running ? "bg-accent" : "bg-ink-faint"}`} />
								) : (
									<span className="block h-[9px] w-[9px] rounded-full border border-dashed border-line" />
								)}
							</span>
							<ScrollText
								text={todo.content}
								className={`dw-fade-tail min-w-0 flex-1 text-[12px] ${
									todo.status === "completed" ? "text-ink-faint line-through decoration-line" : "text-ink-muted"
								}`}
							/>
						</div>
					))}
				</>
			)}

			{runs.length > 0 && (
				<>
					<Header label="执行记录" hint={String(runs.length)} />
					{runs.map((run) => (
						<div key={run.toolCallId} className="dw-scroll flex items-center gap-2 rounded-md px-1.5 py-[5px]">
							<span
								className={`h-[6px] w-[6px] shrink-0 rounded-full ${
									run.status === "running" ? "dw-pulse bg-info" : run.status === "error" ? "bg-danger" : "bg-ok/70"
								}`}
							/>
							<ScrollText text={run.summary} className="dw-fade-tail min-w-0 flex-1 text-[12px] text-ink-muted" />
							<Text size="caption" tone="faint" numeric className="shrink-0">
								{run.finishedAt ? formatSpan(run.finishedAt - run.startedAt) : "进行中"}
							</Text>
						</div>
					))}
				</>
			)}
		</Scroller>
	);
}

function Header({ label, hint }: { label: string; hint: string }) {
	return (
		<div className="flex items-center justify-between px-1.5 pt-3 pb-1">
			<Text size="caption" tone="faint">
				{label}
			</Text>
			<Text size="caption" tone="faint" numeric>
				{hint}
			</Text>
		</div>
	);
}

/** Whole seconds under a minute; nobody is timing a tool call to the millisecond. */
function formatSpan(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}
