/**
 * The runtime that turns settings + a workspace into a running agent.
 *
 * Everything user-facing goes through here: the desktop main process, the sync server and the CLI
 * all drive the same `AgentSession`, so the phone and the desktop cannot drift.
 *
 * What is left in this file is the driving: take a prompt, run a turn, stop, queue, approve. What
 * the session *has done* is `SessionLog` — the transcript and the append-only log kept as one
 * thing — and what it *can do* is `SessionCapabilities`. Both are held rather than inherited, so
 * the boundary is visible at every call site.
 */

import type { AgentEvent, AgentEventSink, QueuedTask } from "../agent/events.ts";
import type { AgentRunConfig } from "../agent/loop.ts";
import type { Settings } from "../config/settings.ts";
import { resolveModel } from "../config/settings.ts";
import type { Boundary, SessionMeta } from "../session/store.ts";
import type { SessionStorage } from "../session/storage.ts";
import type { ApprovalDecision, ApprovalRequest, Message, ThinkingLevel, Tool, UserContent } from "../types.ts";
import { ApprovalGate, sessionApprovalGate } from "./approvals.ts";
import type { ContextBreakdown } from "./context.ts";
import { describeContext, describeSession, type SessionFacts, type SessionStatus } from "./reporting.ts";
import { SessionCapabilities } from "./session-capabilities.ts";
import { scratchDir, sessionFacts } from "./session-facts.ts";
import { SessionLog } from "./session-log.ts";
import { driveTurn } from "./session-turn.ts";
import { sessionTaskQueue, type TaskQueue } from "./task-queue.ts";

export interface AgentSessionOptions {
	cwd: string;
	settings: Settings;
	store: SessionStorage;
	meta?: SessionMeta;
	emit: AgentEventSink;
	/**
	 * Tools that only exist on a particular host — the desktop app contributes browser
	 * automation backed by a real BrowserWindow, which the platform-agnostic core cannot build.
	 */
	extraTools?: Tool[];
	/**
	 * Replaces the provider call, exactly as `AgentRunConfig.streamFn` does one layer down.
	 *
	 * Exposed here so behaviour that lives in the session rather than the loop — the task
	 * queue, in particular — can be exercised without a network round trip.
	 */
	streamFn?: AgentRunConfig["streamFn"];
}

export class AgentSession {
	readonly store: SessionStorage;
	readonly log: SessionLog;
	readonly can: SessionCapabilities;
	cwd: string;

	private settings: Settings;
	private streamFn?: AgentRunConfig["streamFn"];
	private controller: AbortController | null = null;
	private steering: Message[] = [];
	private readonly approvals: ApprovalGate;
	private readonly tasks: TaskQueue = sessionTaskQueue({
		run: (task) => this.prompt([{ type: "text", text: task.text }], { origin: task.origin }),
		busy: () => this.running,
		changed: (tasks) => this.emit({ type: "tasks", tasks }),
	});

	constructor(options: AgentSessionOptions) {
		this.cwd = options.cwd;
		this.settings = options.settings;
		this.store = options.store;
		this.streamFn = options.streamFn;
		this.log = new SessionLog(options.store, options.emit, options.meta);
		this.can = new SessionCapabilities(options.extraTools ?? []);
		this.approvals = sessionApprovalGate({
			mode: () => this.settings.permissionMode,
			cwd: () => this.cwd,
			emit: (event) => this.emit(event),
			alwaysAllow: options.settings.alwaysAllow,
		});
	}

	/** The history, as callers have always read it. */
	get meta(): SessionMeta {
		return this.log.meta;
	}

	get messages(): Message[] {
		return this.log.messages;
	}

	/**
	 * Adopt a transcript read back from disk, and where the model's view of it begins.
	 *
	 * Both, because they are two halves of one fact. Restoring the messages without the boundary
	 * reopens a compacted session on its full history: correct on screen, and back over the context
	 * window on the first prompt — which then compacts again, from scratch, having thrown away the
	 * summary it paid for last time.
	 */
	restore(messages: Message[], compaction: Boundary | null = null): void {
		this.log.restore(messages, compaction);
	}

	get running(): boolean {
		return this.controller !== null;
	}

	/** Load skills, agents and MCP tools. Safe to call again after settings change. */
	async initialize(): Promise<void> {
		if (!this.log.meta) {
			this.log.meta = await this.store.create(this.cwd, this.settings.defaultModelId ?? "");
		}
		await this.can.load(this.cwd, this.settings);
	}

	async status(): Promise<SessionStatus> {
		return describeSession(this.facts());
	}

	async contextBreakdown(): Promise<ContextBreakdown | null> {
		return describeContext(this.facts());
	}

	private facts(): SessionFacts {
		const { log, can, cwd, settings, running } = this;
		return sessionFacts({ log, can, cwd, settings, running });
	}

	/** Drop the cached symbol index so the next `symbol` lookup re-reads it from disk. */
	invalidateSymbolIndex(): void {
		this.can.invalidateSymbolIndex();
	}

	updateSettings(settings: Settings): void {
		this.settings = settings;
		for (const subject of settings.alwaysAllow) this.approvals.allow(subject);
	}

	/**
	 * Pick the model, before there is any history to be incompatible with.
	 *
	 * Refused once the conversation has started, and the reason is mechanical rather than
	 * stylistic. Stored messages carry provider-specific handles: the Responses `responseId`
	 * that chains a conversation, the `signature` on a thinking or tool-call block, the
	 * encrypted reasoning payload replayed on the following turn. Handed to a different model
	 * these are at best ignored — losing the reasoning context the turn was built on — and at
	 * worst rejected. Across API formats the history cannot be re-expressed at all.
	 *
	 * Enforced here rather than in the UI so every caller is bound by it: the phone and the
	 * scheduler drive this same object.
	 */
	async setModel(modelId: string): Promise<boolean> {
		if (this.log.messages.length > 0) return false;
		const meta = { ...this.log.meta, modelId };
		this.log.meta = meta;
		await this.log.append({ type: "meta", meta });
		return true;
	}

	// -------------------------------------------------------------------------
	// Running a turn
	// -------------------------------------------------------------------------

	/**
	 * Send a prompt. If the agent is already running, the message is queued as steering and
	 * picked up between turns instead of starting a second concurrent run.
	 */
	async prompt(content: UserContent[], options: { thinking?: ThinkingLevel; origin?: "side-chat" } = {}): Promise<void> {
		const message: Message = {
			role: "user",
			content,
			timestamp: Date.now(),
			...(options.origin ? { origin: options.origin } : {}),
		};

		if (this.running) {
			this.steering.push(message);
			return;
		}

		await this.log.commit(message);
		await this.emit({ type: "message_start", message });
		await this.emit({ type: "message_end", message });

		if (this.log.messages.filter((m) => m.role === "user").length === 1) {
			await this.setTitleFromPrompt(content);
		}

		await this.run(options.thinking);
	}

	private async run(thinking?: ThinkingLevel): Promise<void> {
		const resolved = resolveModel(this.settings, this.log.meta.modelId || this.settings.defaultModelId);
		if (!resolved) {
			await this.emit({
				type: "notice",
				level: "error",
				message: "No model is configured. Add a provider in Settings → Models first.",
			});
			await this.emit({ type: "agent_end", reason: "error", error: "no_model" });
			return;
		}

		this.controller = new AbortController();
		try {
			await driveTurn({
				cwd: this.cwd,
				settings: this.settings,
				log: this.log,
				can: this.can,
				provider: resolved.provider,
				model: resolved.model,
				signal: this.controller.signal,
				thinking,
				streamFn: this.streamFn,
				scratchDir: scratchDir(this.log.meta.id),
				requestApproval: (request) => this.requestApproval(request),
				emit: (event) => this.emit(event),
				drainSteering: () => this.steering.splice(0, this.steering.length),
			});
		} finally {
			this.controller = null;
			// Anything still waiting for approval would hang forever once the run is over.
			this.approvals.rejectAll();
		}

		// The queue moves the moment the workspace is free again. Skipped while draining,
		// because that loop is already the thing calling us.
		void this.tasks.drain();
	}

	abort(): void {
		this.controller?.abort();
		this.approvals.rejectAll();
		// Stop means stop. Letting the queue carry on after the button was pressed would be
		// the opposite of what pressing it asks for.
		void this.tasks.cancelAll();
	}

	// -------------------------------------------------------------------------
	// Dispatched work
	// -------------------------------------------------------------------------

	get taskQueue(): QueuedTask[] {
		return this.tasks.list();
	}

	async enqueueTask(text: string, origin: QueuedTask["origin"] = "side-chat"): Promise<QueuedTask> {
		return this.tasks.enqueue(text, origin);
	}

	async cancelTask(taskId: string): Promise<boolean> {
		return this.tasks.cancel(taskId);
	}

	private emit(event: AgentEvent): Promise<void> {
		return this.log.emit(event);
	}

	// -------------------------------------------------------------------------
	// Approvals
	// -------------------------------------------------------------------------

	private requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
		return this.approvals.request(request);
	}

	resolveApproval(requestId: string, decision: ApprovalDecision): boolean {
		return this.approvals.resolve(requestId, decision);
	}

	listPendingApprovals(): { id: string; request: ApprovalRequest }[] {
		return this.approvals.list();
	}

	// -------------------------------------------------------------------------
	// Misc
	// -------------------------------------------------------------------------

	/**
	 * Replace a message and run again from there.
	 *
	 * Editing what you asked invalidates the answer and everything built on it, so the tail is
	 * discarded rather than left dangling above a contradictory reply.
	 */
	async editAndResend(
		messageIndex: number,
		content: UserContent[],
		options: { thinking?: ThinkingLevel } = {},
	): Promise<void> {
		if (this.running) return;
		if (!(await this.log.truncateFrom(messageIndex))) return;

		await this.emit({ type: "rewound", messageCount: this.log.messages.length });
		await this.prompt(content, options);
	}

	private async setTitleFromPrompt(content: UserContent[]): Promise<void> {
		const text = content.find((c) => c.type === "text")?.text ?? "";
		const title = text.replace(/\s+/g, " ").trim().slice(0, 60) || "New session";
		await this.log.append({ type: "title", title });
		await this.emit({ type: "title", title });
	}

	async dispose(): Promise<void> {
		this.abort();
		await this.can.dispose();
	}
}
