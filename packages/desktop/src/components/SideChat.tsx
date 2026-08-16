/**
 * The conversation beside the conversation.
 *
 * A scratchpad that can see what the main session is doing but does not write into it. Anything
 * that needs doing gets dispatched to that session's queue instead, which is what `TaskStrip`
 * below the messages reports on.
 *
 * Only the arrangement lives here: a message is `sidechat/MessageRow`, the dispatched work is
 * `sidechat/TaskStrip`, and the field is `sidechat/SideComposer`.
 */

import { CircleDashed, MessageCirclePlus } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { useSide } from "../sideStore.ts";
import { PanelEmpty } from "./PanelEmpty.tsx";
import { Scroller } from "./Scroller.tsx";
import { lastIsSettled, MessageRow, rowKey } from "./sidechat/MessageRow.tsx";
import { SideComposer } from "./sidechat/SideComposer.tsx";
import { TaskStrip } from "./sidechat/TaskStrip.tsx";

/** Within this far of the bottom counts as "following along", so new messages keep scrolling. */
const PIN_SLACK = 60;

export function SideChat() {
	const messages = useSide((s) => s.messages);
	const running = useSide((s) => s.running);
	const sessionId = useSide((s) => s.sessionId);
	const ask = useSide((s) => s.ask);
	const abort = useSide((s) => s.abort);
	const reset = useSide((s) => s.reset);

	const scrollRef = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);

	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el || !pinned.current) return;
		el.scrollTop = el.scrollHeight;
	}, [messages]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{!sessionId ? (
				// It reads the conversation it is attached to; without one there is nothing to be
				// beside.
				<PanelEmpty icon={MessageCirclePlus} title="侧边聊天">
					先在左边开始一个对话。侧边聊天读的是那个对话，没有它就无从谈起。
				</PanelEmpty>
			) : messages.length === 0 ? (
				<PanelEmpty icon={MessageCirclePlus} title="侧边聊天">
					临时对话，关闭应用后消失。它看得见主会话聊了什么，但说的话不会写进去；需要动手的事，它会交给主会话排队执行。
				</PanelEmpty>
			) : (
				<Scroller
					className="flex-1"
					scrollRef={scrollRef}
					contentClassName="px-3"
					onScroll={(el) => {
						pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK;
					}}
				>
					{/*
					 * Capped and centred, exactly as the main transcript is.
					 *
					 * At panel width this changes nothing. Full screen it is the difference between
					 * a conversation and a wall of text a metre wide — prose stops being readable
					 * somewhere around 90 characters, and the panel is over twice that when it
					 * takes the whole column.
					 */}
					<div className="mx-auto w-full max-w-[var(--ly-content)] py-3">
						{messages.map((message, index) => (
							<MessageRow key={rowKey(message, index)} message={message} />
						))}
						{running && lastIsSettled(messages) && (
							<div className="flex items-center gap-2 py-1 text-detail text-ink-faint">
								<CircleDashed size={13} strokeWidth={1.8} className="ly-spin" />
								思考中…
							</div>
						)}
					</div>
				</Scroller>
			)}

			<TaskStrip />

			<SideComposer
				running={running}
				disabled={!sessionId}
				onSend={(content) => void ask(content)}
				onStop={() => void abort()}
				onReset={messages.length > 0 ? () => void reset() : undefined}
			/>
		</div>
	);
}
