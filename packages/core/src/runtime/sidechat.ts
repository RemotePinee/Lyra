/**
 * The side chat: a second conversation that reads the main one but cannot touch the workspace.
 *
 * It exists for the question you want to ask *about* a run without putting it *into* the run —
 * "what does that error mean", "why did it pick that file". Asked in the main conversation,
 * that exchange would live in its history forever, riding along in every later request and
 * nudging the agent off the thing it was doing. Asked here, it leaves no trace.
 *
 * Three properties, in the order they matter:
 *
 *   - it reads the main transcript, so you never have to re-explain the context;
 *   - nothing it says is written back, so the main conversation is unchanged by asking;
 *   - it has no way to act on the workspace itself.
 *
 * That last one is not caution, it is the design. Two agents editing one working tree is a
 * conflict waiting to happen. So when the side chat concludes that something needs doing, it
 * hands the work to the main session instead, which runs it after whatever it is already
 * doing. One executor per workspace, always.
 */

import type { AgentEvent, AgentEventSink } from "../agent/events.ts";
import { runAgent, textResult } from "../agent/loop.ts";
import type { Settings } from "../config/settings.ts";
import { resolveModel } from "../config/settings.ts";
import type { Message, ThinkingLevel, Tool, UserContent } from "../types.ts";
import type { AgentSession } from "./session.ts";

export interface SideChatOptions {
	main: AgentSession;
	settings: Settings;
	emit: AgentEventSink;
}

export interface SideChatState {
	messages: Message[];
	running: boolean;
}

export class SideChat {
	readonly mainSessionId: string;

	private main: AgentSession;
	private settings: Settings;
	private emitExternal: AgentEventSink;

	messages: Message[] = [];
	private controller: AbortController | null = null;

	/**
	 * How much of the main transcript has already been handed over.
	 *
	 * The whole point of tracking this is cost. A main session forty turns deep is a large
	 * amount of context; re-sending all of it on every question would multiply that by the
	 * number of questions asked. The first question carries a full snapshot, and each one
	 * after it carries only what the main session has produced since — which is usually
	 * nothing, and never more than a turn or two.
	 */
	private syncedMainCount = 0;

	constructor(options: SideChatOptions) {
		this.main = options.main;
		this.mainSessionId = options.main.meta.id;
		this.settings = options.settings;
		this.emitExternal = options.emit;
	}

	get running(): boolean {
		return this.controller !== null;
	}

	state(): SideChatState {
		return { messages: this.messages, running: this.running };
	}

	updateSettings(settings: Settings): void {
		this.settings = settings;
	}

	/** Start over. The main conversation is untouched, as always. */
	reset(): void {
		this.abort();
		this.messages = [];
		this.syncedMainCount = 0;
	}

	abort(): void {
		this.controller?.abort();
		this.controller = null;
	}

	async ask(content: UserContent[], options: { thinking?: ThinkingLevel } = {}): Promise<void> {
		if (this.running) return;

		/*
		 * Always the main session's model, never a choice of its own.
		 *
		 * The side chat exists to reason about that conversation, and answering questions about
		 * it with a different model would mean two different readers of the same transcript
		 * giving different accounts of it — which is worse than useless when the whole point is
		 * to ask "what did it just do".
		 */
		const resolved = resolveModel(this.settings, this.main.meta.modelId || this.settings.defaultModelId);
		if (!resolved) {
			await this.emit({ type: "notice", level: "error", message: "没有可用的模型，请先在设置里配置。" });
			await this.emit({ type: "agent_end", reason: "error", error: "no_model" });
			return;
		}

		// Bring the main conversation up to date before the question is asked, so "what just
		// happened" is answered against what actually just happened.
		this.catchUp();

		const question: Message = { role: "user", content, timestamp: Date.now() };
		this.messages.push(question);
		await this.emit({ type: "message_start", message: question });
		await this.emit({ type: "message_end", message: question });

		this.controller = new AbortController();
		try {
			await runAgent(
				{
					sessionId: `${this.mainSessionId}:side`,
					cwd: this.main.cwd,
					provider: resolved.provider,
					model: resolved.model,
					systemPrompt: this.systemPrompt(),
					tools: [dispatchTaskTool(this.main)],
					messages: this.messages,
					thinking: options.thinking ?? this.settings.thinking,
					retryAttempts: this.settings.retryAttempts,
					signal: this.controller.signal,
					maxTurns: 12,
				},
				(event) => this.handleEvent(event),
			);
		} finally {
			this.controller = null;
		}
	}

	/**
	 * Append whatever the main session has produced since the last question.
	 *
	 * Written as ordinary messages in this conversation's own history rather than folded into
	 * the system prompt, so the provider's prompt cache still covers them — a system prompt
	 * that changes every turn is a cache miss every turn.
	 */
	private catchUp(): void {
		const main = this.main.messages;
		if (main.length === 0 || main.length === this.syncedMainCount) return;

		const first = this.syncedMainCount === 0;
		const slice = main.slice(this.syncedMainCount);
		const body = transcribe(slice);
		if (!body) {
			this.syncedMainCount = main.length;
			return;
		}

		this.messages.push({
			role: "user",
			content: [
				{
					type: "text",
					text: first
						? `以下是主会话到目前为止的完整记录，供你参考：\n\n${body}`
						: `主会话在你上次回答之后的新进展：\n\n${body}`,
				},
			],
			timestamp: Date.now(),
			synthetic: true,
		});
		this.syncedMainCount = main.length;
	}

	private systemPrompt(): string {
		const queue = this.main.taskQueue.filter((t) => t.status === "queued" || t.status === "running");
		const status = this.main.running ? "正在执行" : "空闲";
		const queueLines =
			queue.length === 0
				? "（空）"
				: queue.map((t) => `- [${t.status === "running" ? "执行中" : "排队中"}] ${t.text}`).join("\n");

		return [
			"你是 DeepWise 的侧边助手，附在用户当前的主会话旁边。",
			"",
			"# 你的处境",
			"",
			"你能看到主会话的完整记录，但你说的任何话都不会写进主会话的历史。用户来找你，通常是因为他想弄清楚主会话里发生了什么，又不想让这段问答污染主会话的上下文。",
			"",
			"# 你能做什么",
			"",
			"分析、解释、判断、拆解问题。基于主会话的记录直接回答，不要让用户重新交代背景。",
			"",
			"# 你不能做什么",
			"",
			"你没有任何操作工作区的能力——不能读写文件、不能执行命令。这是刻意的：主会话可能正在改同一份代码，两边同时动手必然冲突。",
			"",
			"需要动手时，用 dispatch_task 把这件事交给主会话。它会在手头的事情做完之后执行。写指令时要完整、可独立执行，因为主会话看不到你和用户的这段对话——它只会收到你写的那一句话。",
			"",
			"不要为了显得有用而派活。只有用户明确要求，或者他的意图显然是「去做这件事」时才派。",
			"",
			"# 主会话此刻的状态",
			"",
			`状态：${status}`,
			`待执行队列：`,
			queueLines,
			"",
			"# 回答风格",
			"",
			"简短、直接、说人话。用中文。不要复述用户已经知道的东西。",
		].join("\n");
	}

	private async handleEvent(event: AgentEvent): Promise<void> {
		// The side chat's history lives in memory only, so there is no commit step — the
		// message list the loop is mutating *is* the transcript.
		await this.emit(event);
	}

	private async emit(event: AgentEvent): Promise<void> {
		await this.emitExternal(event);
	}
}

/**
 * The side chat's one and only tool.
 *
 * It does not touch the workspace — it puts a note in the main session's queue and returns.
 * Everything that could actually change a file happens later, in the main session, under the
 * same approval rules as anything the user typed themselves.
 */
function dispatchTaskTool(main: AgentSession): Tool<{ instruction: string }> {
	return {
		name: "dispatch_task",
		description:
			"把一件需要动手的事交给主会话执行（改文件、跑命令、查代码等）。主会话会在完成当前工作后按顺序执行。" +
			"instruction 必须是一条完整、可独立执行的指令——主会话看不到侧边聊天的上下文。",
		snippet: "dispatch_task — 把需要动手的工作交给主会话排队执行",
		parameters: {
			type: "object",
			properties: {
				instruction: {
					type: "string",
					description: "交给主会话的完整指令，写成可以直接执行的一句话或一段话。",
				},
			},
			required: ["instruction"],
		},
		summarize: (args) => `派给主会话：${String(args.instruction ?? "").slice(0, 40)}`,
		async execute(args) {
			const instruction = String(args.instruction ?? "").trim();
			if (!instruction) return textResult("指令为空，没有派出任何任务。");
			const task = await main.enqueueTask(instruction);
			return textResult(
				main.running
					? "已排入主会话的任务队列，它会在当前工作完成后执行。"
					: "主会话当前空闲，已经开始执行。",
				task,
			);
		},
	};
}

/** Per-tool-result cap. A single file read can be longer than the entire conversation around it. */
const RESULT_CHARS = 400;

/**
 * Flatten a slice of transcript into something readable.
 *
 * Thinking blocks are dropped: they are the longest part of a transcript and the least useful
 * second-hand. Tool results are truncated hard — what matters is that a tool ran and roughly
 * what came back, not its full output.
 */
function transcribe(messages: Message[]): string {
	const lines: string[] = [];

	for (const message of messages) {
		if (message.role === "user") {
			const text = message.content
				.map((block) => (block.type === "text" ? block.text : "[图片]"))
				.join("\n")
				.trim();
			if (!text) continue;
			const who = message.origin === "side-chat" ? "任务（由侧边派出）" : message.synthetic ? "系统" : "用户";
			lines.push(`【${who}】${text}`);
			continue;
		}

		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text" && block.text.trim()) lines.push(`【助手】${block.text.trim()}`);
				else if (block.type === "toolCall") lines.push(`【工具】${block.name} ${compactArgs(block.arguments)}`);
			}
			continue;
		}

		const text = message.content
			.map((block) => (block.type === "text" ? block.text : "[图片]"))
			.join("\n")
			.trim();
		const clipped = text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}…（已截断）` : text;
		lines.push(`【结果${message.isError ? " · 失败" : ""}】${clipped}`);
	}

	return lines.join("\n\n");
}

function compactArgs(args: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		if (text === undefined) continue;
		parts.push(`${key}=${text.length > 80 ? `${text.slice(0, 80)}…` : text}`);
		if (parts.length >= 3) break;
	}
	return parts.join(" ");
}
