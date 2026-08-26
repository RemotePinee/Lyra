import { useApp } from "../store.ts";
import { useConfirmer } from "./Confirm.tsx";
import { hasRetryPoint } from "../store/derive.ts";

/**
 * The turn stopped somewhere short of the end, and here is how to pick it up.
 *
 * Pressing stop, quitting the app mid-turn, a crash, a machine going to sleep, or a model that
 * ended cleanly with items still on its own list: five ways to arrive at a conversation with
 * work left in it. Two questions follow — carry on, or do that last part again — and both are one
 * click, because retyping the request is the only alternative and it is a bad one.
 *
 * The pause used to be the one case with no answer here. Stopping is not damage, so nothing was
 * recorded and nothing was offered, and a turn you paused three seconds ago looked exactly like a
 * conversation that had finished. Getting back into it meant typing 「继续」 by hand — which is
 * the whole of what the button does, so the only thing being asked for was the typing.
 *
 * Deliberately the quietest thing on the page. It sits where the timestamps sit, in the same
 * grey at the same size: it is a footnote about what happened, not an alarm. Anything louder
 * would make an ordinary pause look like a failure.
 */
export function ResumeRow() {
	const send = useApp((s) => s.send);
	const retryFrom = useApp((s) => s.retryFrom);
	const running = useApp((s) => s.running);
	const stopped = useApp((s) => s.stopped);
	const messages = useApp((s) => s.messages);
	const todos = useApp((s) => s.todos);
	const confirm = useConfirmer();

	const unfinished = todos.filter((todo) => todo.status !== "completed").length;
	/*
	 * Three ways for work to be left undone, and the same two things to offer for all of them.
	 *
	 * The third is the quiet one and was not covered at all — the model ends its turn cleanly with
	 * items still on its list. Nothing is wrong in that case, which is exactly why nothing said
	 * anything, and the plan sat there unfinished with no way back into it.
	 */
	if (running || (!stopped && unfinished === 0)) return null;

	/*
	 * What happened, in the fewest words that are true.
	 *
	 * The plan's count is the fallback rather than the headline: when the turn stopped in the
	 * middle, *that* is the news, and 「计划还有 3 项未完成」 buries it under a number.
	 */
	const note =
		stopped === "user"
			? "已暂停"
			: stopped === "error"
				? "上次请求失败，进度已保留"
				: stopped === "interrupt"
					? "上次执行被中断"
					: `计划还有 ${unfinished} 项未完成`;
	/*
	 * What 继续 says, matched to what actually happened.
	 *
	 * 「从中断的地方接着做」 is a lie in the third case: nothing was interrupted, the model simply
	 * finished a turn with items still on its list. The model reads this message and acts on it, so
	 * a wrong account of where it stopped is a wrong instruction, not just a wrong word.
	 */
	const carryOn =
		stopped === "user"
			? "继续，从暂停的地方接着做。"
			: stopped === "error" || stopped === "interrupt"
				? "继续，从中断的地方接着做。"
				: "继续，把清单里没做完的做完。";

	return (
		<div className="ly-enter mb-2.5 flex items-center gap-2 text-detail text-ink-faint">
			<span>{note}</span>
			<span className="text-line">·</span>
			<button
				type="button"
				data-ly-tip="接着做完没做完的部分"
				onClick={() => void send([{ type: "text", text: carryOn }])}
				className="rounded px-1 text-ink-muted underline decoration-line underline-offset-2 transition-colors hover:text-ink"
			>
				继续
			</button>
			{/*
			 * Not a second kind of "carry on": this one throws the reply away and asks again.
			 *
			 * Which is what makes it worth having next to 继续 — between them they cover both
			 * readings of a turn that stopped. Either what it did so far is worth keeping and the
			 * rest should follow, or it went wrong somewhere back there and the whole answer should
			 * be had again. The tooltip says which, because "重试" alone does not, and one of the
			 * two is destructive.
			 */}
			{hasRetryPoint(messages) && (
				<button
					type="button"
					data-ly-tip="丢掉这次的回答，重新生成"
					/*
					 * Asked first, because this one is the expensive mistake.
					 *
					 * 继续 and 重试 sit next to each other and read as two flavours of the same
					 * offer, and they are opposites: one keeps everything the turn did and adds to
					 * it, the other throws all of it away and pays for it again. On a turn that had
					 * already spent several hundred thousand tokens reading a codebase, pressing the
					 * wrong one costs that much a second time — and nothing about the word 「重试」
					 * says so.
					 */
					onClick={() =>
						confirm.ask({
							title: "重新生成这次回答？",
							detail: (
								<>
									这会丢掉本轮已经做过的工作——读过的文件、跑过的命令、写到一半的回答——
									并从你最后一条消息重新开始，重新消耗一次 token。
									<br />
									想保留这些、只把没做完的做完，请选「继续」。
								</>
							),
							confirmLabel: "重新生成",
							onConfirm: () => void retryFrom(messages.length - 1),
						})
					}
					className="rounded px-1 text-ink-muted underline decoration-line underline-offset-2 transition-colors hover:text-ink"
				>
					重试
				</button>
			)}
			{confirm.element}
		</div>
	);
}
