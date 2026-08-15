/**
 * The runtime that turns settings + a workspace into a running agent.
 *
 * Everything user-facing goes through here: the desktop main process, the sync server and
 * the CLI all drive the same `AgentSession`, so the phone and the desktop cannot drift.
 */

import { randomUUID } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentEventSink, QueuedTask } from "../agent/events.ts";
import type { AgentRunConfig } from "../agent/loop.ts";
import { runTurn } from "../agent/runner.ts";
import type { PermissionMode, Settings } from "../config/settings.ts";
import { resolveModel } from "../config/settings.ts";
import { McpManager, type McpServerStatus } from "../mcp/client.ts";
import { loadPlugins, type Plugin, type PluginDiagnostic } from "../plugins/loader.ts";
import { buildSystemPrompt, loadProjectInstructions } from "../prompt/system.ts";
import { formatSkillCatalogue, loadSkills, parseFrontmatter, type Skill, type SkillDiagnostic } from "../skills/loader.ts";
import { registeredSkills } from "../skills/registry.ts";
import { SKILLS_KEY } from "../skills/tool.ts";
import { deepwiseHome, type SessionMeta } from "../session/store.ts";
import type { SessionStorage } from "../session/storage.ts";
import { writePreview } from "./previews.ts";
import { assessCommand, assessNetwork, assessWrite } from "../tools/risk.ts";
import { builtinTools, invalidateIndex } from "../tools/index.ts";
import { AGENTS_KEY, BUILTIN_AGENTS, type AgentDefinition } from "../tools/task.ts";
import type {
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
import { nextTask } from "./scheduling.ts";
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
	private pendingApprovals = new Map<string, PendingApproval>();
	/** Subjects the user chose "always allow" for, within this process. */
	private allowList = new Set<string>();
	/**
	 * Work waiting behind whatever is running, plus a short tail of what already ran.
	 *
	 * Deliberately not the steering queue. Steering splices a message between turns of the
	 * current run, which is right for "actually, also check X" but wrong for a dispatched
	 * task — that is a separate piece of work and must not blur into the one in progress.
	 */
	private tasks: QueuedTask[] = [];
	/** Guards the drain loop against the re-entry its own `run()` would otherwise cause. */
	private draining = false;

	constructor(options: AgentSessionOptions) {
		this.cwd = options.cwd;
		this.settings = options.settings;
		this.store = options.store;
		this.emitExternal = options.emit;
		this.extraTools = options.extraTools ?? [];
		this.streamFn = options.streamFn;
		if (options.meta) this.meta = options.meta;
		for (const subject of options.settings.alwaysAllow) this.allowList.add(subject);
	}

	get running(): boolean {
		return this.controller !== null;
	}

	/** Load skills, agents and MCP tools. Safe to call again after settings change. */
	async initialize(): Promise<void> {
		if (!this.meta) {
			this.meta = await this.store.create(this.cwd, this.settings.defaultModelId ?? "");
		}

		const loadedPlugins = await loadPlugins(
			[
				{ dir: join(this.cwd, ".deepwise", "plugins"), source: "workspace" as const },
				{ dir: join(deepwiseHome(), "plugins"), source: "user" as const },
			],
			this.settings.disabledPlugins,
		);
		this.plugins = loadedPlugins.plugins;
		this.pluginDiagnostics = loadedPlugins.diagnostics;

		const loaded = await loadSkills([
			{ dir: join(this.cwd, ".deepwise", "skills"), source: "workspace" as const },
			{ dir: join(deepwiseHome(), "skills"), source: "user" as const },
		]);
		// Loose skills win over bundled ones with the same name, so a project can override a
		// plugin's skill by dropping a directory next to it.
		const looseNames = new Set(loaded.skills.map((skill) => skill.name));
		const pluginSkills = this.plugins
			.filter((plugin) => plugin.enabled)
			.flatMap((plugin) => plugin.skills)
			.filter((skill) => !looseNames.has(skill.name));

		// Code-provided skills sit behind both, for the same reason: what the user put on disk is
		// the most specific statement of intent in the room.
		const known = new Set([...looseNames, ...pluginSkills.map((skill) => skill.name)]);
		const fromPlugins = registeredSkills().filter((skill) => !known.has(skill.name));

		this.skills = [...loaded.skills, ...pluginSkills, ...fromPlugins];
		this.skillDiagnostics = loaded.diagnostics;
		this.state.set(SKILLS_KEY, this.skills);

		this.agents = [...BUILTIN_AGENTS, ...(await loadAgentDefinitions(this.cwd))];
		this.state.set(AGENTS_KEY, this.agents);

		const pluginServers = this.plugins.filter((plugin) => plugin.enabled).flatMap((plugin) => plugin.mcpServers);
		this.mcpStatuses = await this.mcp.connectAll([...this.settings.mcpServers, ...pluginServers]);
		this.tools = [...builtinTools(), ...this.extraTools, ...this.mcp.allTools()];
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
		for (const subject of settings.alwaysAllow) this.allowList.add(subject);
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
					spawnSubAgent: (input) => this.runSubAgent(input, resolved.provider, resolved.model, systemPrompt),
					drainSteering: () => this.steering.splice(0, this.steering.length),
					beforeToolCall: makeBeforeToolCall(this.settings.hooks, this.cwd, this.controller.signal),
					afterToolCall: makeAfterToolCall(this.settings.hooks, this.cwd, this.controller.signal),
					compact: (messages, model) => compactWith(messages, model, resolved.provider),
					streamFn: this.streamFn,
				},
				(event) => this.handleAgentEvent(event),
			);

			void result;
		} finally {
			this.controller = null;
			// Anything still waiting for approval would hang forever once the run is over.
			for (const pending of this.pendingApprovals.values()) pending.resolve("reject");
			this.pendingApprovals.clear();
		}

		// The queue moves the moment the workspace is free again. Skipped while draining,
		// because that loop is already the thing calling us.
		if (!this.draining) void this.drainTasks();
	}

	abort(): void {
		this.controller?.abort();
		for (const pending of this.pendingApprovals.values()) pending.resolve("reject");
		this.pendingApprovals.clear();
		// Stop means stop. Letting the queue carry on after the button was pressed would be
		// the opposite of what pressing it asks for.
		void this.cancelAllTasks();
	}

	// -------------------------------------------------------------------------
	// Dispatched work
	// -------------------------------------------------------------------------

	get taskQueue(): QueuedTask[] {
		return this.tasks;
	}

	/**
	 * Hand this session a piece of work to run once it is free.
	 *
	 * Runs immediately when nothing is in progress, which is the whole point: you dispatch it
	 * and walk away. Approvals still reach the user through the ordinary path — a task can ask
	 * for a file to be written, it cannot grant itself permission to write it.
	 */
	async enqueueTask(text: string, origin: QueuedTask["origin"] = "side-chat"): Promise<QueuedTask> {
		const task: QueuedTask = {
			id: randomUUID(),
			text,
			origin,
			status: "queued",
			createdAt: Date.now(),
		};
		this.tasks = [...trimTaskHistory(this.tasks), task];
		await this.emitTasks();
		void this.drainTasks();
		return task;
	}

	/** Withdraw a task that has not started. One already running is not cancellable — that is `abort`. */
	async cancelTask(taskId: string): Promise<boolean> {
		const task = this.tasks.find((t) => t.id === taskId);
		if (!task || task.status !== "queued") return false;
		task.status = "cancelled";
		task.finishedAt = Date.now();
		await this.emitTasks();
		return true;
	}

	private async cancelAllTasks(): Promise<void> {
		let changed = false;
		for (const task of this.tasks) {
			if (task.status !== "queued" && task.status !== "running") continue;
			task.status = "cancelled";
			task.finishedAt = Date.now();
			changed = true;
		}
		if (changed) await this.emitTasks();
	}

	private async emitTasks(): Promise<void> {
		await this.emit({ type: "tasks", tasks: this.tasks.map((task) => ({ ...task })) });
	}

	private async drainTasks(): Promise<void> {
		if (this.draining || this.running) return;
		this.draining = true;
		try {
			while (true) {
				const next = nextTask(this.tasks);
				if (!next) return;

				next.status = "running";
				next.startedAt = Date.now();
				await this.emitTasks();

				let failure: string | null = null;
				try {
					await this.prompt([{ type: "text", text: next.text }], { origin: next.origin });
				} catch (cause) {
					failure = cause instanceof Error ? cause.message : String(cause);
				}

				/*
				 * Re-read rather than writing to `next` directly.
				 *
				 * `abort` cancels whatever is running, and it can land at any point during the
				 * await above. Its verdict is the user's; ours is a guess made before the fact.
				 * Looking the task up again is also what stops the compiler assuming the status
				 * is still what we set it to a few lines ago — it genuinely might not be.
				 */
				const settled = this.tasks.find((t) => t.id === next.id);
				if (settled?.status === "running") {
					settled.status = failure ? "failed" : "done";
					if (failure) settled.error = failure;
					settled.finishedAt = Date.now();
				}
				await this.emitTasks();
			}
		} finally {
			this.draining = false;
		}
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

	private async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
		const mode: PermissionMode = this.settings.permissionMode;
		if (mode === "full") return "once";
		if (this.allowList.has(request.subject)) return "once";
		/*
		 * "帮我批准" asks about what cannot be taken back, and nothing else.
		 *
		 * It used to allow only a list of read-only commands, which meant it interrupted almost
		 * every turn — models write `cd x && git log; echo ---`, not bare `ls`. A prompt that
		 * fires constantly is not a safeguard; it is something you learn to click through, which
		 * is worse than not having it. Writing files, installing packages and committing are the
		 * work. Deleting trees, rewriting history, escalating privileges and reaching outside the
		 * project are the things worth stopping for.
		 */
		if (mode === "auto") {
			const verdict =
				request.kind === "bash"
					? assessCommand(request.subject, this.cwd)
					: request.kind === "edit" || request.kind === "write"
						? assessWrite(request.subject, this.cwd)
						: request.kind === "network"
							? assessNetwork(request.subject)
							: { risky: true as const };
			if (!verdict.risky) return "once";
			if (verdict.reason) request.detail = `${verdict.reason}\n\n${request.detail ?? ""}`.trim();
		}

		const id = randomUUID();
		return new Promise<ApprovalDecision>((resolve) => {
			this.pendingApprovals.set(id, {
				id,
				request,
				resolve: (decision) => {
					this.pendingApprovals.delete(id);
					if (decision === "always") this.allowList.add(request.subject);
					resolve(decision === "always" ? "once" : decision);
				},
			});
			void this.emit({
				type: "approval_request",
				requestId: id,
				toolCallId: id,
				kind: request.kind,
				title: request.title,
				detail: request.detail,
			});
		});
	}

	resolveApproval(requestId: string, decision: ApprovalDecision): boolean {
		const pending = this.pendingApprovals.get(requestId);
		if (!pending) return false;
		pending.resolve(decision);
		return true;
	}

	listPendingApprovals(): { id: string; request: ApprovalRequest }[] {
		return [...this.pendingApprovals.values()].map(({ id, request }) => ({ id, request }));
	}

	// -------------------------------------------------------------------------
	// Sub-agents
	// -------------------------------------------------------------------------

	private async runSubAgent(
		input: { description: string; prompt: string; agentType?: string },
		provider: ProviderConfig,
		model: ModelConfig,
		parentSystemPrompt: string,
	): Promise<string> {
		const definition = this.agents.find((a) => a.name === (input.agentType ?? "general")) ?? BUILTIN_AGENTS[0];
		const allowed =
			definition.tools === "*" ? this.tools : this.tools.filter((t) => (definition.tools as string[]).includes(t.name));

		// The sub-agent gets its own message list and its own state map, so its file reads and
		// todo list cannot leak into the parent's.
		const id = `${this.meta.id}:sub:${randomUUID().slice(0, 8)}`;
		const steps: string[] = [];
		await this.emit({
			type: "subagent",
			id,
			agent: definition.name,
			description: input.description,
			prompt: input.prompt,
			tools: allowed.map((tool) => tool.name),
		});

		const result = await runTurn(
			{
				sessionId: id,
				cwd: this.cwd,
				provider,
				model,
				systemPrompt: `${definition.systemPrompt}\n\n${parentSystemPrompt.split("# Environment")[1] ? `# Environment${parentSystemPrompt.split("# Environment")[1].split("\n\n#")[0]}` : ""}`,
				tools: allowed,
				messages: [{ role: "user", content: [{ type: "text", text: input.prompt }], timestamp: Date.now() }],
				thinking: this.settings.thinking,
					retryAttempts: this.settings.retryAttempts,
				signal: this.controller?.signal,
				state: new Map<string, unknown>([
					[SKILLS_KEY, this.skills],
					[AGENTS_KEY, this.agents],
				]),
				requestApproval: (request) => this.requestApproval(request),
				// Inherited, so a host that replaced the provider call replaced it for the whole
				// tree — a sub-agent quietly dialling out would defeat the point of overriding it.
				streamFn: this.streamFn,
				maxTurns: 60,
			},
			(event) => {
				// Surfaced as a notice for the live view, kept as a step for the log.
				if (event.type === "tool_start") {
					steps.push(event.summary);
					void this.emit({
						type: "notice",
						level: "info",
						message: `[${definition.name}] ${event.summary}`,
					});
				}
			},
		);

		const last = [...result.messages].reverse().find((m) => m.role === "assistant");
		const answer =
			last?.role === "assistant"
				? last.content
						.filter((c) => c.type === "text")
						.map((c) => c.text)
						.join("\n")
						.trim()
				: "";

		await this.emit({ type: "subagent_done", id, steps, answer });
		return answer;
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

/**
 * Load custom sub-agent definitions from `.deepwise/agents/*.md`, mirroring the skill format:
 * YAML frontmatter for metadata, markdown body for the system prompt.
 */
async function loadAgentDefinitions(cwd: string): Promise<AgentDefinition[]> {
	const out: AgentDefinition[] = [];

	for (const [dir, source] of [
		[join(cwd, ".deepwise", "agents"), "workspace"],
		[join(deepwiseHome(), "agents"), "user"],
	] as const) {
		const entries = await readdir(dir).catch(() => []);
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			const raw = await readFile(join(dir, entry), "utf8").catch(() => null);
			if (!raw) continue;
			const parsed = parseFrontmatter(raw);
			if (!parsed) continue;
			const { frontmatter, body } = parsed;
			const name = typeof frontmatter.name === "string" ? frontmatter.name : entry.replace(/\.md$/, "");
			if (out.some((a) => a.name === name)) continue;
			out.push({
				name,
				description: typeof frontmatter.description === "string" ? frontmatter.description : name,
				systemPrompt: body,
				tools: Array.isArray(frontmatter.tools)
					? (frontmatter.tools as unknown[]).filter((t): t is string => typeof t === "string")
					: "*",
				model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
				source,
			});
		}
	}
	return out;
}
