import { useApp } from "../store.ts";

/**
 * The turn stopped somewhere it did not choose to, and here is how to pick it up.
 *
 * Quitting the app mid-turn, a crash, a machine going to sleep: the conversation reopens with a
 * half-written reply and no account of why it ends there. Two questions follow — carry on, or
 * do that last part again — and both are one click, because retyping the request is the only
 * alternative and it is a bad one.
 *
 * Deliberately the quietest thing on the page. It sits where the timestamps sit, in the same
 * grey at the same size: it is a footnote about what happened, not an alarm. Anything louder
 * would make an ordinary interruption look like a failure.
 */
export function ResumeRow() {
	const send = useApp((s) => s.send);
	const running = useApp((s) => s.running);
	const interrupted = useApp((s) => s.interrupted);
	const todos = useApp((s) => s.todos);

	const unfinished = todos.filter((todo) => todo.status !== "completed").length;
	/*
	 * Two ways for work to be left undone, and the same thing to offer for both.
	 *
	 * One is an interruption: the log stops mid-turn because the process went away. The other is
	 * quieter and was not covered at all — the model ended its turn cleanly with items still on
	 * its own list. Nothing is wrong in that second case, which is exactly why nothing said
	 * anything, and the plan sat there unfinished with no way back into it.
	 */
	if (running || (!interrupted && unfinished === 0)) return null;

	return (
		<div className="dw-enter mb-2.5 flex items-center gap-2 text-[11.5px] text-ink-faint">
			<span>{interrupted ? "上次执行被中断" : `计划还有 ${unfinished} 项未完成`}</span>
			<span className="text-line">·</span>
			<button
				type="button"
				onClick={() => void send([{ type: "text", text: "继续，从中断的地方接着做。" }])}
				className="rounded px-1 text-ink-muted underline decoration-line underline-offset-2 transition-colors hover:text-ink"
			>
				继续
			</button>
			{/* Only for an interruption: a turn that ended cleanly has nothing to try again. */}
			{interrupted && (
				<button
					type="button"
					// The last thing it tried, rather than the whole turn: the earlier steps landed.
					onClick={() => void send([{ type: "text", text: "重试刚才没有完成的那一步。" }])}
					className="rounded px-1 text-ink-muted underline decoration-line underline-offset-2 transition-colors hover:text-ink"
				>
					重试
				</button>
			)}
		</div>
	);
}
