/**
 * Asking about the pull request you are looking at.
 *
 * Not the workspace conversation. The questions here are about somebody else's branch — "what
 * breaks if this merges", "why this guard and not that one", "draft me a comment" — and the
 * answers belong beside the diff, not in the middle of whatever you were building. Sending it to
 * the project session also asked the agent to reason about a repository that, for most of this
 * list, is not on the machine at all.
 *
 * The session it runs in has a scratch directory rather than a project, which is the point: an
 * agent does not need a working tree to read a patch and have an opinion about it.
 */

import { MessagesSquare, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PullRequestDetail as Detail } from "../../../electron/ipc-types.ts";
import { usePrChat } from "../../prChatStore.ts";
import { ComposerSend, ComposerShell } from "../ComposerShell.tsx";
import { PanelEmpty } from "../PanelEmpty.tsx";
import { Scroller } from "../Scroller.tsx";
import { lastIsSettled, MessageRow, rowKey } from "../sidechat/MessageRow.tsx";

/** Within this far of the bottom counts as following along, so new messages keep scrolling. */
const PIN_SLACK = 60;

export function PullRequestChat({ detail }: { detail: Detail }) {
	const messages = usePrChat((s) => s.messages);
	const running = usePrChat((s) => s.running);
	const loading = usePrChat((s) => s.loading);
	const error = usePrChat((s) => s.error);
	const sessionId = usePrChat((s) => s.sessionId);
	const open = usePrChat((s) => s.open);
	const ask = usePrChat((s) => s.ask);
	const abort = usePrChat((s) => s.abort);
	const pendingAsk = usePrChat((s) => s.pendingAsk);

	const [draft, setDraft] = useState("");
	const scrollRef = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);

	// Opening is idempotent per pull request, so this settles immediately when switching back to
	// one already loaded.
	useEffect(() => {
		void open(detail);
	}, [detail, open]);

	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el || !pinned.current) return;
		el.scrollTop = el.scrollHeight;
	}, [messages]);

	// A question asked before there was a session to ask it in — the 审查 button, usually, which
	// opens this tab and asks in the same click.
	useEffect(() => {
		if (!sessionId || !pendingAsk || running) return;
		usePrChat.setState({ pendingAsk: null });
		void ask(pendingAsk);
	}, [sessionId, pendingAsk, running, ask]);

	const send = () => {
		const text = draft.trim();
		if (!text || running) return;
		setDraft("");
		void ask(text);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{messages.length === 0 ? (
				<div className="flex min-h-0 flex-1 flex-col justify-center">
					<PanelEmpty icon={MessagesSquare} title="聊这个 Pull Request">
						{loading
							? "正在准备…"
							: "问它风险、影响面，或者让它替你起草一条审查意见。它不在你的项目里，读的是这个 PR。"}
					</PanelEmpty>
				</div>
			) : (
				<Scroller
					className="flex-1"
					scrollRef={scrollRef}
					contentClassName="px-4 pt-2"
					fadeColor="var(--color-shell)"
					// Following along only while near the bottom: scrolling up to re-read something
					// should not be undone by the next chunk of the reply arriving.
					onScroll={(el) => {
						pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK;
					}}
				>
					{messages.map((message, index) => (
						<MessageRow key={rowKey(message, index)} message={message} />
					))}
					{running && lastIsSettled(messages) && <p className="ly-breathe px-1 py-2 text-detail text-ink-faint">思考中…</p>}
				</Scroller>
			)}

			{error && <p className="shrink-0 px-4 pb-1 text-detail leading-relaxed text-danger">{error}</p>}

			<div className="shrink-0 px-4 pt-1 pb-3">
				<ComposerShell
					value={draft}
					onChange={setDraft}
					onSubmit={send}
					disabled={!sessionId}
					placeholder={sessionId ? "问点关于这个 PR 的…" : "正在准备…"}
					right={
						<ComposerSend
							running={running}
							disabled={!sessionId || (!running && !draft.trim())}
							onSend={send}
							onStop={() => void abort()}
						/>
					}
					left={
						running ? (
							<button
								type="button"
								onClick={() => void abort()}
								className="flex h-[26px] items-center gap-1.5 rounded-lg px-2 text-detail text-ink-muted transition-colors hover:bg-card-hover hover:text-ink"
							>
								<Square size={11} strokeWidth={2.4} />
								停止
							</button>
						) : undefined
					}
				/>
			</div>
		</div>
	);
}
