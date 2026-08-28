/**
 * One delegated run, read from the outside — and, while it lasts, reachable.
 *
 * The shape is the side chat's, because the thing being done is the same thing: a conversation
 * beside the main one, in its own pane, that you can type into. What it is *not* is a second
 * executor. Typing here does not start anything of its own; it splices a message into the
 * sub-agent's own loop between turns, so it finishes the step it is on, reads what you said with
 * its context intact, and carries on.
 *
 * Which is also the whole of how this reaches the main agent: it does not. The sub-agent reports
 * back to the parent when it finishes, and steering changes what that report says. One executor
 * per workspace — two agents writing to one working tree is a conflict waiting to happen, and the
 * indirection is the design rather than a limitation of it.
 *
 * A tab strip above, because a parent dispatching three searches at once is the case this exists
 * for, and choosing between them *is* the title.
 */

import { Bot, CircleStop, RotateCcw, Send, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { SubAgentSummary } from "@lyra/core";
import { useApp } from "../../store.ts";
import { rosterOrder, useSubAgents } from "../../store/subAgents.ts";
import { Markdown } from "../Markdown.tsx";
import { PanelEmpty } from "../PanelEmpty.tsx";
import { Scroller } from "../Scroller.tsx";
import { ranFor, statusTone, statusWord } from "./format.ts";
import { SubAgentMessageRow, subAgentRuns } from "./SubAgentMessageRow.tsx";

/** How close to the bottom still counts as "following along" — the side chat's own slack. */
const PIN_SLACK = 60;

export function SubAgentPanel() {
	const sessionId = useApp((s) => s.activeSessionId);
	const agents = useSubAgents((s) => s.agents);
	const focused = useSubAgents((s) => s.focused);
	const ordered = rosterOrder(agents);

	/*
	 * Which one is being read, decided here rather than stored.
	 *
	 * The roster is re-broadcast on every tool call of every sub-agent, so anything derived from it
	 * in the store would churn. Falling back to the first — running ones sort first — means the
	 * pane opens onto something useful without ever moving off what you chose.
	 */
	const current = ordered.find((one) => one.id === focused) ?? ordered[0] ?? null;

	useEffect(() => {
		if (current && sessionId) void useSubAgents.getState().load(sessionId, current.id);
	}, [current, sessionId]);

	if (agents.length === 0) {
		return (
			<PanelEmpty icon={Bot} title="子 Agent">
				主 Agent 把一部分工作派发出去时，这里会显示每个子 Agent 在做什么。它们各自有独立的上下文，正在运行的可以直接对话来纠偏。
			</PanelEmpty>
		);
	}

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<Tabs agents={ordered} current={current?.id ?? null} />
			{current && <Transcript key={current.id} agent={current} sessionId={sessionId} />}
		</div>
	);
}

function Tabs({ agents, current }: { agents: SubAgentSummary[]; current: string | null }) {
	const strip = useRef<HTMLDivElement>(null);

	// Keep the open one in view: the pane can be focused from the bar, which may scroll it in
	// from either end.
	useEffect(() => {
		if (!current) return;
		strip.current?.querySelector(`[data-sub-tab="${CSS.escape(current)}"]`)?.scrollIntoView({
			block: "nearest",
			inline: "nearest",
		});
	}, [current]);

	if (agents.length < 2) return null;

	return (
		<div
			ref={strip}
			role="tablist"
			aria-label="子 Agent"
			className="ly-fade-tail flex h-7 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-1"
		>
			{agents.map((one) => {
				const active = one.id === current;
				return (
					<div
						key={one.id}
						data-sub-tab={one.id}
						className={`group/subtab flex h-[22px] shrink-0 items-center gap-1.5 rounded-md pr-0.5 pl-2 transition-colors duration-[var(--ly-t-quick)] ${
							active ? "bg-card-hover text-ink" : "text-ink-faint hover:text-ink"
						}`}
					>
						<button
							type="button"
							role="tab"
							aria-selected={active}
							data-ly-tip={`${one.agent} · ${statusWord(one.status)} · ${ranFor(one)}`}
							onClick={() => useSubAgents.getState().focus(one.id)}
							className="flex min-w-0 items-center gap-1.5 text-detail"
						>
							{/* The dot carries the state, so the name does not have to spell it out. */}
							<span
								className={`size-[5px] shrink-0 rounded-full ${statusTone(one.status)} ${
									one.status === "running" ? "ly-pulse" : ""
								}`}
							/>
							<span className="max-w-[140px] truncate whitespace-nowrap">{one.description}</span>
						</button>
						{/*
						 * Closing a row, which for a running sub-agent means stopping it first.
						 *
						 * The label says which, because the two are different acts: one is putting a
						 * record away, the other ends work that is in progress and costs whatever it
						 * had spent. Never a silent un-listing — a sub-agent removed while running
						 * would go on running with nothing able to steer or stop it.
						 */}
						<Dismiss agent={one} />
					</div>
				);
			})}
		</div>
	);
}

function Dismiss({ agent }: { agent: SubAgentSummary }) {
	const sessionId = useApp((s) => s.activeSessionId);
	const running = agent.status === "running";
	return (
		<button
			type="button"
			data-ly-tip={running ? "停止并关闭（会中断它正在做的事）" : "关闭"}
			aria-label={running ? `停止并关闭 ${agent.description}` : `关闭 ${agent.description}`}
			onClick={async () => {
				if (!sessionId) return;
				const what = await window.lyra.subAgents.dismiss(sessionId, agent.id);
				// Stopping is not instant: the run files itself as aborted, and the row goes on the
				// second press. Saying so beats a click that appears to do nothing.
				if (what === "stopping") useApp.getState().notify("正在停止这个子 Agent…", "info");
			}}
			className="rounded p-0.5 opacity-0 transition-opacity duration-[var(--ly-t-quick)] group-hover/subtab:opacity-60 hover:!opacity-100 hover:bg-elevated"
		>
			<X size={11} strokeWidth={2.2} />
		</button>
	);
}

function Transcript({ agent, sessionId }: { agent: SubAgentSummary; sessionId: string | null }) {
	const messages = useSubAgents((s) => s.transcripts[agent.id]);
	const loading = useSubAgents((s) => s.loading.includes(agent.id));
	const scrollRef = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);

	const toolRuns = useMemo(() => subAgentRuns(messages ?? []), [messages]);

	// Follow along while it is working, unless you have scrolled up to read something.
	useLayoutEffect(() => {
		if (!pinned.current) return;
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages]);

	return (
		<>
			<Header agent={agent} sessionId={sessionId} />
			<Scroller
				className="flex-1"
				scrollRef={scrollRef}
				contentClassName="px-3 py-2"
				onScroll={(el) => {
					pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK;
				}}
			>
				{!messages || messages.length === 0 ? (
					<p className="px-2 py-8 text-center text-detail text-ink-faint">
						{loading || agent.status === "running" ? "刚开始，还没有输出。" : "这个子 Agent 没有留下内容。"}
					</p>
				) : (
					messages.map((message, at) => (
						<SubAgentMessageRow
							key={`${agent.id}:${at}`}
							message={message}
							toolRuns={toolRuns}
							isLive={agent.status === "running" && at === messages.length - 1}
						/>
					))
				)}
				{/*
				 * The answer, marked as the one thing the parent actually saw.
				 *
				 * Everything above it is the sub-agent's own working — the point of delegation is
				 * that none of it reached the parent's context. Saying which part did is what makes
				 * the transcript legible as "what was delegated and what came back".
				 */}
				{agent.status === "done" && agent.answer && (
					<div className="mt-2 rounded-lg border border-line-soft bg-card/50 px-3 py-2">
						<p className="mb-1 text-caption text-ink-faint">回报给主 Agent</p>
						{/*
						 * Rendered, not printed.
						 *
						 * A sub-agent's report is written for the model to read and is Markdown like any
						 * other reply — file paths in backticks, findings in a list, emphasis on what
						 * matters. Shown raw it was a wall of asterisks and hyphens, which is both
						 * harder to read than the plain prose it replaced and inconsistent with the
						 * same text everywhere else in the window.
						 */}
						<Markdown text={agent.answer} />
					</div>
				)}
				{agent.status === "failed" && agent.error && (
					<p className="mt-2 rounded-lg border border-danger/30 px-3 py-2 text-detail text-danger">{agent.error}</p>
				)}
				{/*
				 * A way back from the two endings that were not the point.
				 *
				 * A sub-agent that failed or was stopped leaves the parent holding an error where it
				 * expected a report — and the parent is the only thing that can dispatch another,
				 * because it owns the `task` call and the context that produced the prompt. So this
				 * does not re-run anything itself: it asks the main agent to, in as many words, and
				 * the main agent decides whether that is still the right move. Same indirection as
				 * steering, for the same reason — one executor per workspace.
				 */}
				{(agent.status === "failed" || agent.status === "aborted") && <Redispatch agent={agent} />}
			</Scroller>
			{agent.status === "running" && sessionId && <Steer agent={agent} sessionId={sessionId} />}
		</>
	);
}

function Redispatch({ agent }: { agent: SubAgentSummary }) {
	const [asked, setAsked] = useState(false);
	return (
		<button
			type="button"
			disabled={asked}
			data-ly-tip="让主 Agent 重新派发一个同样的子任务"
			onClick={() => {
				/*
				 * Through the composer, not straight to the model.
				 *
				 * It lands as a draft you can read, edit, or throw away before anything runs — the
				 * request is a sentence about work that already cost something once, and pressing a
				 * button should not be the last word on spending it again.
				 */
				useApp
					.getState()
					.setComposerDraft(
						`刚才那个子任务「${agent.description}」${agent.status === "failed" ? "失败了" : "被停掉了"}，重新派发一个同样的子 agent 去做。`,
						true,
					);
				setAsked(true);
			}}
			className="mt-2 flex items-center gap-1.5 rounded-lg border border-line-soft px-2.5 py-1.5 text-detail text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover hover:text-ink disabled:opacity-50"
		>
			<RotateCcw size={11.5} strokeWidth={1.9} />
			{asked ? "已填入输入框" : "让主 Agent 重新派发"}
		</button>
	);
}

function Header({ agent, sessionId }: { agent: SubAgentSummary; sessionId: string | null }) {
	/* A clock while it runs, frozen at the end once it has. */
	const [, tick] = useState(0);
	useEffect(() => {
		if (agent.status !== "running") return;
		const timer = window.setInterval(() => tick((n) => n + 1), 1000);
		return () => window.clearInterval(timer);
	}, [agent.status]);

	return (
		<div className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-2.5 text-caption text-ink-faint">
			<span className={`size-[5px] shrink-0 rounded-full ${statusTone(agent.status)}`} />
			<span className="shrink-0">{agent.agent}</span>
			<span className="text-line">·</span>
			<span className="shrink-0 tabular-nums">{ranFor(agent)}</span>
			{agent.toolCalls > 0 && (
				<>
					<span className="text-line">·</span>
					<span className="shrink-0 tabular-nums">{agent.toolCalls} 次调用</span>
				</>
			)}
			{/* The newest thing it did, which is what answers "is this stuck?". */}
			{agent.status === "running" && agent.lastActivity && (
				<span className="ly-fade-tail min-w-0 flex-1 truncate text-ink-faint">{agent.lastActivity}</span>
			)}
			<span className="min-w-2 flex-1" />
			{agent.status === "running" && sessionId && (
				<button
					type="button"
					data-ly-tip="停止这个子 Agent（主 Agent 和其他子 Agent 不受影响）"
					aria-label="停止这个子 Agent"
					onClick={() => void window.lyra.subAgents.abort(sessionId, agent.id)}
					className="flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover hover:text-danger"
				>
					<CircleStop size={12} strokeWidth={1.9} />
				</button>
			)}
		</div>
	);
}

/**
 * Say something to a sub-agent that is still running.
 *
 * Only while it is running, and not as a disabled field afterwards: there is no loop left to read
 * the message, so an input that accepted one would swallow it. A finished sub-agent is a transcript.
 */
function Steer({ agent, sessionId }: { agent: SubAgentSummary; sessionId: string }) {
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);

	const send = async () => {
		const message = text.trim();
		if (!message || sending) return;
		setSending(true);
		const delivered = await window.lyra.subAgents.steer(sessionId, agent.id, message);
		setSending(false);
		if (delivered) setText("");
		// It finished between typing and pressing. Saying so beats clearing the box as though it
		// had been delivered.
		else useApp.getState().notify("这个子 Agent 已经结束了，消息没有送达。", "error");
	};

	return (
		<div className="shrink-0 border-t border-line p-2">
			<div className="flex items-end gap-1.5 rounded-lg border border-hairline bg-shell px-2 py-1.5">
				<textarea
					value={text}
					rows={1}
					placeholder="纠偏、补充信息，或让它收尾…"
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							void send();
						}
					}}
					className="ly-scroll max-h-24 min-w-0 flex-1 resize-none bg-transparent text-label leading-relaxed text-ink outline-none placeholder:text-ink-faint"
				/>
				<button
					type="button"
					data-ly-tip="发给这个子 Agent（它会读完再继续，不会重来）"
					aria-label="发给这个子 Agent"
					disabled={!text.trim() || sending}
					onClick={() => void send()}
					className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover hover:text-ink disabled:opacity-40"
				>
					<Send size={12} strokeWidth={1.9} />
				</button>
			</div>
		</div>
	);
}
