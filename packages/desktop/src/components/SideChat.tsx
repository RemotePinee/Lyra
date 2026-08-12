import type { AssistantMessage, Message, QueuedTask, UserContent } from "@deepwise/core";
import {
	ArrowUp,
	Ban,
	Check,
	ChevronDown,
	CircleDashed,
	Clock,
	MessageCirclePlus,
	RotateCcw,
	Square,
	TriangleAlert,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ComposerSend, ComposerShell } from "./ComposerShell.tsx";
import { Markdown } from "./Markdown.tsx";
import { PanelEmpty } from "./PanelEmpty.tsx";
import { Scroller } from "./Scroller.tsx";
import { ThinkingBlock } from "./ThinkingBlock.tsx";
import { ToolCard } from "./ToolCard.tsx";
import { useSide } from "../sideStore.ts";
import { useApp } from "../store.ts";

/**
 * The conversation beside the conversation.
 *
 * Everything here is deliberately lighter than the main transcript: no timestamps, no edit
 * affordance, no usage line. This is a scratchpad you ask questions in, and the ceremony that
 * belongs on a permanent record would be noise on one that is thrown away at quit.
 */
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
					fadeColor="var(--color-shell)"
					onScroll={(el) => {
						pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
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
					<div className="mx-auto w-full max-w-[var(--dw-content)] py-3">
						{messages.map((message, index) => (
							<Row key={rowKey(message, index)} message={message} />
						))}
						{running && lastIsSettled(messages) && (
							<div className="flex items-center gap-2 py-1 text-[12px] text-ink-faint">
								<CircleDashed size={13} strokeWidth={1.8} className="dw-spin" />
								思考中…
							</div>
						)}
					</div>
				</Scroller>
			)}

			<TaskStrip />

			<Composer
				running={running}
				disabled={!sessionId}
				onSend={(content) => void ask(content)}
				onStop={() => void abort()}
				onReset={messages.length > 0 ? () => void reset() : undefined}
			/>
		</div>
	);
}

function rowKey(message: Message, index: number): string {
	if (message.role === "toolResult") return `tr-${message.toolCallId}`;
	return `${message.role}-${message.timestamp}-${index}`;
}

function Row({ message }: { message: Message }) {
	if (message.role === "toolResult") return null;

	if (message.role === "user") {
		// The main-transcript snapshots injected before each question are context for the model,
		// not something the user wrote — showing them would bury the actual conversation.
		if (message.synthetic) return null;
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		return (
			<div className="dw-enter mb-4 flex justify-end">
				<div className="max-w-[88%] rounded-[13px] rounded-br-[5px] bg-card px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-ink">
					{text}
				</div>
			</div>
		);
	}

	return <AssistantRow message={message} />;
}

function AssistantRow({ message }: { message: AssistantMessage }) {
	const toolRuns = useSide((s) => s.toolRuns);

	return (
		<div className="dw-enter mb-4">
			{message.content.map((block, index) => {
				if (block.type === "thinking") {
					return (
						<ThinkingBlock
							key={index}
							text={block.thinking}
							redacted={block.redacted === true}
							live={message.stopReason === "pending"}
						/>
					);
				}
				if (block.type === "text") {
					return block.text ? (
						<div key={index} className="mb-2">
							<Markdown text={block.text} />
						</div>
					) : null;
				}
				const run = toolRuns[block.id];
				return (
					<ToolCard
						key={block.id}
						toolName={block.name}
						args={block.arguments}
						summary={run?.summary ?? block.name}
						status={run?.status ?? "running"}
						result={run?.result}
					/>
				);
			})}

			{message.stopReason === "error" && message.errorMessage && (
				<div className="mt-2 rounded-[9px] border border-danger/35 bg-danger/8 px-3 py-2 text-[12px] text-danger">
					{message.errorMessage}
				</div>
			)}
		</div>
	);
}

function lastIsSettled(messages: Message[]): boolean {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "assistant") return true;
	return !last.content.some((c) => (c.type === "text" && c.text) || c.type === "toolCall");
}

// ---------------------------------------------------------------------------
// Dispatched work
// ---------------------------------------------------------------------------

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

/**
 * What the side chat has handed over, and where it got to.
 *
 * Collapsed to one line by default. The interesting fact is almost always just "something is
 * queued"; the list matters only when you want to withdraw one.
 */
function TaskStrip() {
	const tasks = useSide((s) => s.tasks);
	const cancelTask = useSide((s) => s.cancelTask);
	const [open, setOpen] = useState(false);

	const active = tasks.filter((t) => t.status === "queued" || t.status === "running");
	// Finished ones linger briefly so a card does not vanish the instant it completes.
	const recent = tasks.filter((t) => t.status !== "queued" && t.status !== "running").slice(-3);
	const shown = open ? [...recent, ...active] : active;

	// Nothing dispatched, nothing to say.
	useEffect(() => {
		if (active.length === 0) setOpen(false);
	}, [active.length]);

	if (active.length === 0) return null;

	const running = active.some((t) => t.status === "running");
	const waiting = active.filter((t) => t.status === "queued").length;
	/*
	 * The count matters even while something is running.
	 *
	 * Saying only "executing" when three more are stacked behind it hides the fact that the
	 * session has a backlog — which is exactly what you need to know before dispatching a
	 * fourth, or deciding to withdraw one.
	 */
	const label = running
		? waiting > 0
			? `正在执行，还有 ${waiting} 个排队`
			: "主会话正在执行派出的任务"
		: `${active.length} 个任务在主会话排队`;

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
				{running ? (
					<CircleDashed size={12.5} strokeWidth={1.9} className="dw-spin shrink-0 text-ink-muted" />
				) : (
					<Clock size={12.5} strokeWidth={1.9} className="shrink-0 text-ink-muted" />
				)}
				<span className="min-w-0 flex-1 truncate">{label}</span>
				<ChevronDown
					size={12}
					strokeWidth={2}
					className="shrink-0 text-ink-faint transition-transform duration-200"
					style={open ? { transform: "rotate(180deg)" } : undefined}
				/>
			</button>

			{open && (
				<div className="flex max-h-[180px] flex-col gap-1 overflow-y-auto pt-1 pb-1">
					{shown.map((task) => {
						const Icon = TASK_ICON[task.status];
						return (
							<div
								key={task.id}
								className="flex items-start gap-2 rounded-lg border border-line-soft px-2 py-1.5 text-[12px]"
							>
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
										title="撤回这个任务"
										onClick={() => void cancelTask(task.id)}
										className="shrink-0 rounded-md px-1.5 py-0.5 text-[11.5px] text-ink-faint transition-colors hover:bg-card-hover hover:text-ink"
									>
										撤回
									</button>
								)}
							</div>
						);
					})}
				</div>
			)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

/**
 * The same surface as the main composer, at panel scale.
 *
 * Not the main `Composer` component itself: that one sends to the active session, carries the
 * project and branch chips, and takes image attachments. None of that applies here — this
 * conversation has no project of its own and cannot act on one.
 */
function Composer({
	running,
	disabled,
	onSend,
	onStop,
	onReset,
}: {
	running: boolean;
	/** No session to be beside; the field stays visible but inert rather than vanishing. */
	disabled?: boolean;
	onSend: (content: UserContent[]) => void;
	onStop: () => void;
	onReset?: () => void;
}) {
	const settings = useApp((s) => s.settings);
	const meta = useApp((s) => s.meta);
	const [text, setText] = useState("");

	function submit() {
		const trimmed = text.trim();
		if (!trimmed || running || disabled) return;
		setText("");
		onSend([{ type: "text", text: trimmed }]);
	}

	// Stated, not offered. The side chat runs on whatever the main session runs on.
	const modelName = findModelName(settings, meta?.modelId ?? settings?.defaultModelId ?? null);

	/*
	 * 15, because of what sits below it: the panel's 4px inset plus its 1px card border. The
	 * main composer rests 20px off the window's bottom edge, and 15 + 1 + 4 lands on the same
	 * line — which is what stops the two fields looking a pixel out of step side by side.
	 */
	return (
		// Same cap as the transcript above it, so the field stays under the messages it answers.
		<div className="mx-auto w-full max-w-[var(--dw-content)] shrink-0 px-3 pt-2 pb-[15px]">
			<ComposerShell
				value={text}
				onChange={setText}
				onSubmit={submit}
				disabled={disabled}
				placeholder={disabled ? "还没有可以聊的会话" : "问点关于这个会话的事"}
				left={
					<span
						title={modelName ? `跟随主会话：${modelName}` : undefined}
						className="h-7 min-w-0 truncate px-2 text-[12.5px] leading-7 text-ink-faint"
					>
						{modelName ?? "未配置模型"}
					</span>
				}
				right={
					<>
						{onReset && !running && (
							<button
								type="button"
								title="新的侧边聊天"
								aria-label="新的侧边聊天"
								onClick={onReset}
								className="mr-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors duration-150 hover:bg-card-hover hover:text-ink active:scale-90"
							>
								<RotateCcw size={13.5} strokeWidth={1.9} />
							</button>
						)}
						<ComposerSend running={running} disabled={!text.trim() || disabled} onSend={submit} onStop={onStop} />
					</>
				}
			/>
		</div>
	);
}

function findModelName(settings: ReturnType<typeof useApp.getState>["settings"], modelId: string | null): string | null {
	if (!settings || !modelId) return null;
	for (const provider of settings.providers) {
		const model = provider.models.find((m) => m.id === modelId);
		if (model) return model.name;
	}
	return null;
}
