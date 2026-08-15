/**
 * The runtime that turns settings + a workspace into a running agent.
 *
 * Everything user-facing goes through here: the desktop main process, the sync server and
 * the CLI all drive the same `AgentSession`, so the phone and the desktop cannot drift.
 */

import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentEventSink, QueuedTask } from "../agent/events.ts";
import type { AgentRunConfig } from "../agent/loop.ts";
import type { streamAssistant } from "../ai/index.ts";
import { runTurn } from "../agent/runner.ts";
import type { PermissionMode, Settings } from "../config/settings.ts";
import { resolveModel } from "../config/settings.ts";
import { McpManager, type McpServerStatus } from "../mcp/client.ts";
import type { Plugin, PluginDiagnostic } from "../plugins/loader.ts";
import { buildSystemPrompt, loadProjectInstructions } from "../prompt/system.ts";
import { formatSkillCatalogue, type Skill, type SkillDiagnostic } from "../skills/loader.ts";
import { SKILLS_KEY } from "../skills/tool.ts";
import { deepwiseHome, type SessionMeta } from "../session/store.ts";
import type { SessionStorage } from "../session/storage.ts";
import { writePreview } from "./previews.ts";
import { ApprovalGate } from "./approvals.ts";
import { runSubAgent } from "./sub-agent.ts";
import { loadCapabilities } from "./session-setup.ts";
import { builtinTools, invalidateIndex } from "../tools/index.ts";
import { AGENTS_KEY, BUILTIN_AGENTS, type AgentDefinition } from "../tools/task.ts";
import type {
	AssistantMessage,
	StreamEvent,
	ApprovalDecision,
	ApprovalRequest,
	Message,
	ModelConfig,
	ProviderConfig,
	ThinkingLevel,
	Tool,
	UserContent,
} from "../types.ts";
import { compactWith } from "./compaction.ts";
import { buildContextBreakdown, type ContextBreakdown } from "./context.ts";
import { TaskQueue } from "./task-queue.ts";
import { prepareTurn, type TurnContext } from "./turn.ts";
import { makeAfterToolCall, makeBeforeToolCall } from "./hooks.ts";

export interface PendingApproval {
	id: string;
	request: ApprovalRequest;
	resolve: (decision: ApprovalDecision) => void;
}

export interface SessionStatus {
	meta: SessionMeta;
	running: boolean;
	skills: Skill[];
	skillDiagnostics: SkillDiagnostic[];
	plugins: Plugin[];
	pluginDiagnostics: PluginDiagnostic[];
	mcp: McpServerStatus[];
	agents: AgentDefinition[];
	toolNames: string[];
}

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

/**
 * Events that outlive the window they were shown in.
 *
 * The log is meant to answer "what did the model actually see, and why did it do that" long after
 * the run — so anything that changes the model's input, or that happened out of view, is kept.
 */
const PERSISTED_EVENTS = new Set<AgentEvent["type"]>(["compacted", "context", "subagent", "subagent_done"]);

export class AgentSession {
	readonly store: SessionStorage;
	private settings: Settings;
	private emitExternal: AgentEventSink;
	private mcp = new McpManager();

	meta!: SessionMeta;
	messages: Message[] = [];
	/** What the last recorded context looked like, so an unchanged one is not written twice. */
	private lastContext: string | null = null;
	cwd: string;

	private tools: Tool[] = [];
	private skills: Skill[] = [];
	private skillDiagnostics: SkillDiagnostic[] = [];
	private mcpStatuses: McpServerStatus[] = [];
	private plugins: Plugin[] = [];
	private pluginDiagnostics: PluginDiagnostic[] = [];
	private agents: AgentDefinition[] = [...BUILTIN_AGENTS];
	private state = new Map<string, unknown>();

	private extraTools: Tool[] = [];
	private streamFn?: AgentRunConfig["streamFn"];
	private controller: AbortController | null = null;
	private steering: Message[] = [];
	/**
	 * Messages already appended to the session log, tracked by identity.
	 *
	 * A prompt sent while the agent is idle is committed here; a steering message is queued
	 * instead and only reaches the transcript when the loop injects it. Both paths end at
	 * `message_end`, so committing there and de-duplicating by identity keeps steering
	 * messages in the log — and in the right position, after the turn they interrupted.
	 */
	private committed = new WeakSet<Message>();
	private readonly approvals: ApprovalGate;
	private readonly tasks: TaskQueue = new TaskQueue({
		run: (task) => this.prompt([{ type: "text", text: task.text }], { origin: task.origin }),
		busy: () => this.running,
		// Copied, not the live list: an event holding a reference would report whatever the
		// queue looked like when someone got round to reading it, not when it was sent.
		changed: (): Promise<void> => this.emit({ type: "tasks", tasks: this.tasks.list().map((task) => ({ ...task })) }),
		newId: () => randomUUID().slice(0, 8),
		now: () => Date.now(),
	});

	constructor(options: AgentSessionOptions) {
		this.cwd = options.cwd;
		this.settings = options.settings;
		this.store = options.store;
		this.emitExternal = options.emit;
		this.extraTools = options.extraTools ?? [];
		this.streamFn = options.streamFn;
		if (options.meta) this.meta = options.meta;
		this.approvals = new ApprovalGate(
			{
				mode: () => this.settings.permissionMode,
				cwd: () => this.cwd,
				ask: (pending) =>
					this.emit({
						type: "approval_request",
						requestId: pending.id,
						toolCallId: pending.id,
						kind: pending.request.kind,
						title: pending.request.title,
						detail: pending.request.detail,
					}),
				remember: () => {},
			},
			options.settings.alwaysAllow,
		);
	}

	get running(): boolean {
		return this.controller !== null;
	}

	/** Load skills, agents and MCP tools. Safe to call again after settings change. */
	async initialize(): Promise<void> {
		if (!this.meta) {
			this.meta = await this.store.create(this.cwd, this.settings.defaultModelId ?? "");
		}

		const loaded = await loadCapabilities(this.cwd, this.settings, this.mcp, this.extraTools);
		this.plugins = loaded.plugins;
		this.pluginDiagnostics = loaded.pluginDiagnostics;
		this.skills = loaded.skills;
		this.skillDiagnostics = loaded.skillDiagnostics;
		this.agents = loaded.agents;
		this.mcpStatuses = loaded.mcpStatuses;
		this.tools = loaded.tools;
		this.state.set(SKILLS_KEY, this.skills);
		this.state.set(AGENTS_KEY, this.agents);
	}

	async status(): Promise<SessionStatus> {
		return {
			meta: this.meta,
			running: this.running,
			skills: this.skills,
			skillDiagnostics: this.skillDiagnostics,
			plugins: this.plugins,
			pluginDiagnostics: this.pluginDiagnostics,
			mcp: this.mcpStatuses,
			agents: this.agents,
			toolNames: this.tools.map((t) => t.name),
		};
	}

	/**
	 * Where this session's context window is going, by segment.
	 *
	 * Built here rather than in the UI because only the session holds the inputs: the assembled
	 * prompt, the tool schemas as the provider will receive them, and which of those tools came
	 * from an MCP server rather than from the kernel. Rebuilding the prompt to measure it is
	 * cheap next to a request, and it is the only way for the figure to be the real one.
	 */
	async contextBreakdown(): Promise<ContextBreakdown | null> {
		const resolved = resolveModel(this.settings, this.meta.modelId || this.settings.defaultModelId);
		if (!resolved) return null;

		const projectInstructions = await loadProjectInstructions(this.cwd);
		const mcpNames = new Set(this.mcp.allTools().map((tool) => tool.name));

		return buildContextBreakdown({
			model: resolved.model,
			messages: this.messages,
			systemPrompt: await buildSystemPrompt({
				cwd: this.cwd,
				tools: this.tools,
				skills: this.skills,
				agents: this.agents,
				projectInstructions,
				platform: platform(),
				modelName: resolved.model.name,
				isGitRepo: await pathExists(join(this.cwd, ".git")),
				today: new Date().toISOString().slice(0, 10),
				scratchDir: this.scratchDir(),
			}),
			builtinTools: this.tools.filter((tool) => !mcpNames.has(tool.name)),
			mcpTools: this.tools.filter((tool) => mcpNames.has(tool.name)),
			skillCatalogue: formatSkillCatalogue(this.skills),
			projectInstructions,
		});
	}

	/**
	 * Where the model can put files that are not part of the project.
	 *
	 * Named for the conversation so two of them cannot tread on each other, and sitting beside
	 * the previews, which are removed on the same occasions and for the same reason.
	 */
	private scratchDir(): string {
		return join(deepwiseHome(), "scratch", this.meta?.id ?? "unsaved");
	}

	/** Drop the cached symbol index so the next `symbol` lookup re-reads it from disk. */
	invalidateSymbolIndex(): void {
		invalidateIndex(this.state);
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
		if (this.messages.length > 0) return false;
		this.meta = { ...this.meta, modelId };
		this.meta = await this.store.append(this.meta, { type: "meta", meta: this.meta });
		return true;
	}

	// -------------------------------------------------------------------------
	// Running a turn
	// -------------------------------------------------------------------------

	/**
	 * Send a prompt. If the agent is already running, the message is queued as steering and
	 * picked up between turns instead of starting a second concurrent run.
	 */
	async prompt(
		content: UserContent[],
		options: { thinking?: ThinkingLevel; origin?: "side-chat" } = {},
	): Promise<void> {
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

		await this.commitMessage(message);
		await this.emit({ type: "message_start", message });
		await this.emit({ type: "message_end", message });

		if (this.messages.filter((m) => m.role === "user").length === 1) {
			await this.setTitleFromPrompt(content);
		}

		await this.run(options.thinking);
	}

	private async run(thinking?: ThinkingLevel): Promise<void> {
		const resolved = resolveModel(this.settings, this.meta.modelId || this.settings.defaultModelId);
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
			/*
			 * Assemble, let plugins amend, then write down what came out.
			 *
			 * The recording happens last on purpose: what belongs in the log is what the model was
			 * actually sent, not what this file would have sent if nothing had intervened.
			 */
			const turn = await prepareTurn({
				cwd: this.cwd,
				tools: this.tools,
				messages: this.messages,
				systemPrompt: await buildSystemPrompt({
					cwd: this.cwd,
					tools: this.tools,
					skills: this.skills,
					agents: this.agents,
					projectInstructions: await loadProjectInstructions(this.cwd),
					platform: platform(),
					modelName: resolved.model.name,
					isGitRepo: await pathExists(join(this.cwd, ".git")),
					today: new Date().toISOString().slice(0, 10),
					scratchDir: this.scratchDir(),
				}),
			});
			const systemPrompt = await this.recordContext(turn);

			const result = await runTurn(
				{
					sessionId: this.meta.id,
					cwd: this.cwd,
					provider: resolved.provider,
					model: resolved.model,
					systemPrompt,
					tools: turn.tools,
					messages: turn.messages,
					thinking: thinking ?? this.settings.thinking,
					retryAttempts: this.settings.retryAttempts,
					signal: this.controller.signal,
					state: this.state,
					/*
					 * Previews are written under the app's directory, keyed by this session.
					 *
					 * The workspace is the user's project; a page produced to demonstrate an idea
					 * is not part of it and should never turn up in `git status`. Keyed by session
					 * so it can be thrown away with the conversation that produced it.
					 */
					writePreview: (input) =>
						writePreview(deepwiseHome(), { ...input, sessionId: this.meta?.id ?? "unsaved" }),
					requestApproval: (request) => this.requestApproval(request),
					spawnSubAgent: (input) =>
						runSubAgent(
							{
								sessionId: this.meta.id,
								cwd: this.cwd,
								settings: this.settings,
								tools: this.tools,
								skills: this.skills,
								agents: this.agents,
								signal: this.controller?.signal,
								streamFn: this.streamFn,
								requestApproval: (request) => this.requestApproval(request),
								emit: (event) => this.emit(event),
							},
							input,
							resolved.provider,
							resolved.model,
							systemPrompt,
						),
					drainSteering: () => this.steering.splice(0, this.steering.length),
					beforeToolCall: makeBeforeToolCall(this.settings.hooks, this.cwd, this.controller.signal),
					afterToolCall: makeAfterToolCall(this.settings.hooks, this.cwd, this.controller.signal),
					// The session's own stream override applies here too; summarising is a model call.
					compact: (messages, model) =>
						compactWith(messages, model, resolved.provider, this.summaryStream(resolved.provider)),
					streamFn: this.streamFn,
				},
				(event) => this.handleAgentEvent(event),
			);

			void result;
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

	private async handleAgentEvent(event: AgentEvent): Promise<void> {
		// `message_end` is the commit point: partial assistant messages are never persisted.
		if (event.type === "message_end") await this.commitMessage(event.message);
		await this.emit(event);
	}

	/** Append a message to the transcript and the log exactly once. */
	private async commitMessage(message: Message): Promise<void> {
		if (this.committed.has(message)) return;
		this.committed.add(message);
		this.messages.push(message);
		this.meta = await this.store.append(this.meta, { type: "message", message });
	}

	/**
	 * Write down what the model is about to be given, the first time it looks like this.
	 *
	 * Returns the prompt so it can wrap the call that produced it — the point is that there is no
	 * way to build a prompt and forget to record it.
	 */
	/**
	 * The provider call compaction should make, in the shape it expects.
	 *
	 * The session's override answers a whole turn; compaction wants a stream. Adapting rather than
	 * reaching for the real provider is the point: a host that replaced how requests are made — a
	 * test, a recorded session, a gateway — must have replaced this one too. Undefined when nothing
	 * was overridden, which leaves the real provider in place.
	 */
	private summaryStream(provider: ProviderConfig): typeof streamAssistant | undefined {
		const override = this.streamFn;
		if (!override) return undefined;
		return (_provider, model, context) => {
			const call = override;
			async function* once(): AsyncGenerator<StreamEvent, AssistantMessage> {
				return call({ ...context }, { provider, model } as AgentRunConfig);
			}
			return once();
		};
	}

	private async recordContext(turn: TurnContext): Promise<string> {
		const systemPrompt = turn.systemPrompt;
		const tools = turn.tools.map((tool) => tool.name).sort();
		const skills = this.skills.map((skill) => skill.name).sort();
		const fingerprint = `${systemPrompt}\u0000${tools.join(",")}\u0000${skills.join(",")}`;
		if (fingerprint === this.lastContext) return systemPrompt;
		this.lastContext = fingerprint;
		await this.emit({ type: "context", systemPrompt, tools, skills });
		return systemPrompt;
	}

	private async emit(event: AgentEvent): Promise<void> {
		/*
		 * Most events are live-only — the window renders them and they are gone, which is right
		 * for progress chatter. The few listed above are not chatter: they are the difference
		 * between a transcript you can read back and one you have to guess at. What the model was
		 * told, what was summarised away, what a sub-agent was sent off to do — none of it can be
		 * recovered from the messages alone, so it is written down as it happens.
		 */
		if (PERSISTED_EVENTS.has(event.type) && this.meta) {
			this.meta = await this.store.append(this.meta, { type: "event", event });
		}
		await this.emitExternal(event);
	}

	// -------------------------------------------------------------------------
	// Approvals
	// -------------------------------------------------------------------------

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
	 * discarded rather than left dangling above a contradictory reply. The truncation goes to
	 * the log first: if the run fails, the history is still the shortened, consistent one
	 * rather than a mix of old and new.
	 */
	async editAndResend(messageIndex: number, content: UserContent[], options: { thinking?: ThinkingLevel } = {}): Promise<void> {
		if (this.running) return;

		const truncated = await this.store.truncateFrom(this.meta.projectId, this.meta.id, messageIndex);
		if (!truncated) return;

		this.meta = truncated.meta;
		this.messages = truncated.messages;
		await this.emit({ type: "rewound", messageCount: this.messages.length });

		await this.prompt(content, options);
	}

	private async setTitleFromPrompt(content: UserContent[]): Promise<void> {
		const text = content.find((c) => c.type === "text")?.text ?? "";
		const title = text.replace(/\s+/g, " ").trim().slice(0, 60) || "New session";
		this.meta = await this.store.append(this.meta, { type: "title", title });
		await this.emit({ type: "title", title });
	}

	async dispose(): Promise<void> {
		this.abort();
		await this.mcp.closeAll();
	}
}

/**
 * Keep every task still to come, and a short tail of what already ran.
 *
 * The finished ones are only there so a card does not vanish the instant it completes. An
 * afternoon of dispatching would otherwise grow an unbounded list nobody reads.
 */
const TASK_HISTORY = 20;

function trimTaskHistory(tasks: QueuedTask[]): QueuedTask[] {
	const settled = tasks.filter((t) => t.status !== "queued" && t.status !== "running");
	if (settled.length <= TASK_HISTORY) return tasks;
	const drop = new Set(settled.slice(0, settled.length - TASK_HISTORY).map((t) => t.id));
	return tasks.filter((t) => !drop.has(t.id));
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
