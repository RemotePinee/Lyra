import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { SyncClient, type Connection } from "./client";
import { summarizeToolCall } from "./toolSummary";
import type {
	AgentEvent,
	AssistantMessage,
	Message,
	RemoteSettings,
	SessionMeta,
	UserContent,
} from "./protocol";

const CONNECTION_KEY = "lyra.connection";

export interface ToolRun {
	toolCallId: string;
	toolName: string;
	summary: string;
	status: "running" | "done" | "error";
	output?: string;
	details?: unknown;
}

export interface PendingApproval {
	id: string;
	kind: string;
	title: string;
	detail: string;
}

export interface CachedSessionData {
	messages: Message[];
	toolRuns: Record<string, ToolRun>;
	seq: number;
	updatedAt: number;
}

interface MobileState {
	hydrated: boolean;
	connection: Connection | null;
	client: SyncClient | null;
	socketState: "connecting" | "open" | "closed";

	sessions: SessionMeta[];
	settings: RemoteSettings | null;
	loadingSessions: boolean;
	error: string | null;

	activeSession: SessionMeta | null;
	messages: Message[];
	toolRuns: Record<string, ToolRun>;
	approvals: PendingApproval[];
	running: boolean;
	turnTokens: number;
	turnStartedAt: number | null;
	/** Highest record seq applied, so a reconnect can resume instead of re-reading everything. */
	seq: number;
	loadingSessionId: string | null;
	loadingEarlier: boolean;
	hasEarlierMessages: boolean;
	minSeq: number;
	cache: Record<string, CachedSessionData>;

	hydrate(): Promise<void>;
	pair(connection: Connection): Promise<boolean>;
	unpair(): Promise<void>;
	refreshSessions(): Promise<void>;
	openSession(meta: SessionMeta): Promise<void>;
	loadEarlierMessages(): Promise<void>;
	closeSession(): void;
	send(text: string, images?: { data: string; mimeType: string }[]): Promise<void>;
	abort(): Promise<void>;
	approve(id: string, decision: "once" | "always" | "reject"): Promise<void>;
	createSession(cwd: string): Promise<SessionMeta | null>;
	setModel(modelId: string): Promise<void>;
}

export const useMobile = create<MobileState>((set, get) => ({
	hydrated: false,
	connection: null,
	client: null,
	socketState: "closed",
	sessions: [],
	settings: null,
	loadingSessions: false,
	error: null,
	activeSession: null,
	messages: [],
	toolRuns: {},
	approvals: [],
	running: false,
	turnTokens: 0,
	turnStartedAt: null,
	seq: 0,
	loadingSessionId: null,
	loadingEarlier: false,
	hasEarlierMessages: false,
	minSeq: 0,
	cache: {},

	async hydrate() {
		const raw = await SecureStore.getItemAsync(CONNECTION_KEY).catch(() => null);
		if (!raw) {
			set({ hydrated: true });
			return;
		}
		try {
			const connection = JSON.parse(raw) as Connection;
			attach(connection, set, get);
			set({ connection, hydrated: true });
			void get().refreshSessions();
		} catch {
			set({ hydrated: true });
		}
	},

	async pair(connection) {
		const client = new SyncClient(connection);
		if (!(await client.verify())) {
			set({ error: "地址或令牌不正确，请检查桌面端的「移动端同步」页面。" });
			return false;
		}
		// Keychain writes can fail (locked device, web preview); pairing should still work
		// for the current session rather than dropping the user back to the pairing screen.
		await SecureStore.setItemAsync(CONNECTION_KEY, JSON.stringify(connection)).catch(() => undefined);
		attach(connection, set, get);
		set({ connection, error: null });
		await get().refreshSessions();
		return true;
	},

	async unpair() {
		get().client?.disconnect();
		await SecureStore.deleteItemAsync(CONNECTION_KEY).catch(() => undefined);
		set({
			connection: null,
			client: null,
			sessions: [],
			settings: null,
			activeSession: null,
			messages: [],
			toolRuns: {},
			approvals: [],
		});
	},

	async refreshSessions() {
		const client = get().client;
		if (!client) return;
		set({ loadingSessions: true, error: null });
		try {
			const [sessions, settings] = await Promise.all([client.listSessions(), client.settings()]);
			// Archived sessions are hidden on the desktop too; the two lists have to agree.
			set({ sessions: sessions.sessions.filter((s) => !s.archived), settings });
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			set({ loadingSessions: false });
		}
	},

	async openSession(meta) {
		const client = get().client;
		if (!client) return;

		// Reset state for the opened session and show loading
		set({
			activeSession: meta,
			messages: [],
			toolRuns: {},
			approvals: [],
			running: false,
			turnStartedAt: null,
			turnTokens: 0,
			seq: 0,
			minSeq: 0,
			hasEarlierMessages: false,
			loadingEarlier: false,
			loadingSessionId: meta.id,
			error: null,
		});

		try {
			// Fetch the latest 120 records so runs aren't starved by consecutive tool calls
			const [res, status] = await Promise.all([
				client.records(meta.projectId, meta.id, { tail: 120 }),
				client.status(meta.projectId, meta.id).catch(() => null),
			]);

			let entries: { seq: number; message: Message }[] = [];
			let seq = 0;
			let minSeq = Infinity;

			for (const record of res.records) {
				seq = Math.max(seq, record.seq);
				minSeq = Math.min(minSeq, record.seq);
				if (record.type === "message") entries.push({ seq: record.seq, message: record.message });
				else if (record.type === "truncate") entries = entries.filter((e) => e.seq <= record.afterSeq);
			}

			const messages = entries.map((e) => e.message);
			const toolRuns = rebuildToolRuns(messages);

			const isRunning = status?.running ?? false;
			set({
				messages,
				seq,
				minSeq: minSeq === Infinity ? 0 : minSeq,
				hasEarlierMessages: !!res.hasEarlier,
				toolRuns,
				loadingSessionId: null,
				running: isRunning,
				turnStartedAt: isRunning ? (get().turnStartedAt ?? Date.now()) : null,
				turnTokens: isRunning ? get().turnTokens : 0,
				approvals:
					status?.pendingApprovals.map((p) => ({
						id: p.id,
						kind: p.request.kind,
						title: p.request.title,
						detail: p.request.detail,
					})) ?? [],
			});
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error), loadingSessionId: null });
		}
	},

	async loadEarlierMessages() {
		const { client, activeSession, minSeq, loadingEarlier, hasEarlierMessages, messages: currentMessages } = get();
		if (!client || !activeSession || loadingEarlier || !hasEarlierMessages || minSeq <= 1) return;

		set({ loadingEarlier: true });
		try {
			// Fetch 60 records strictly before the current earliest sequence
			const res = await client.records(activeSession.projectId, activeSession.id, { before: minSeq, tail: 60 });
			let entries: { seq: number; message: Message }[] = [];
			let nextMinSeq = minSeq;

			for (const record of res.records) {
				nextMinSeq = Math.min(nextMinSeq, record.seq);
				if (record.type === "message") entries.push({ seq: record.seq, message: record.message });
				else if (record.type === "truncate") entries = entries.filter((e) => e.seq <= record.afterSeq);
			}

			const earlierMessages = entries.map((e) => e.message);
			const mergedMessages = [...earlierMessages, ...currentMessages];
			const toolRuns = rebuildToolRuns(mergedMessages);

			set({
				messages: mergedMessages,
				minSeq: nextMinSeq,
				hasEarlierMessages: res.records.length > 0 && nextMinSeq > 1,
				toolRuns,
				loadingEarlier: false,
			});
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error), loadingEarlier: false });
		}
	},

	closeSession() {
		const { activeSession, messages, toolRuns, seq, cache } = get();
		if (activeSession) {
			set({
				cache: trimCache({
					...cache,
					[activeSession.id]: {
						messages,
						toolRuns,
						seq,
						updatedAt: Date.now(),
					},
				}),
				activeSession: null,
			});
		} else {
			set({ activeSession: null });
		}
	},

	async send(text, images = []) {
		const { client, activeSession } = get();
		const trimmed = text.trim();
		if (!client || !activeSession || (!trimmed && images.length === 0)) return;

		const content: UserContent[] = [
			...images.map((img): UserContent => ({ type: "image", data: img.data, mimeType: img.mimeType })),
			...(trimmed ? [{ type: "text" as const, text: trimmed }] : []),
		];

		// Show it immediately (optimistic UI update)
		set({
			messages: [...get().messages, { role: "user", content, timestamp: Date.now() }],
			running: true,
			turnTokens: 0,
			turnStartedAt: Date.now(),
		});
		// Send over network in background so UI doesn't block
		client.prompt(activeSession.projectId, activeSession.id, content).catch((error) => {
			set({ error: error instanceof Error ? error.message : String(error), running: false });
		});
	},

	async abort() {
		const { client, activeSession } = get();
		if (client && activeSession) await client.abort(activeSession.projectId, activeSession.id).catch(() => undefined);
	},

	async approve(id, decision) {
		const { client, activeSession } = get();
		if (!client || !activeSession) return;
		set({ approvals: get().approvals.filter((a) => a.id !== id) });
		await client.approve(activeSession.projectId, activeSession.id, id, decision).catch(() => undefined);
	},

	/**
	 * Choose the model, only while the conversation is still empty.
	 *
	 * The desktop refuses this outright once there is history — stored messages carry
	 * provider-specific handles (response ids, thinking signatures, encrypted reasoning) that
	 * another model cannot replay. Checked here too so the picker does not have to round-trip
	 * to be told no, and the optimistic update now waits for the server to agree: it used to
	 * paint the new model regardless, leaving the phone showing one the session was not using.
	 */
	async setModel(modelId) {
		const { client, activeSession, messages } = get();
		if (!client || !activeSession || messages.length > 0) return;
		const result = await client
			.setModel(activeSession.projectId, activeSession.id, modelId)
			.catch(() => null);
		if (!result?.ok) return;
		set({ activeSession: { ...activeSession, modelId } });
	},

	async createSession(cwd) {
		const client = get().client;
		if (!client) return null;
		try {
			const { meta } = await client.createSession(cwd, get().settings?.defaultModelId ?? undefined);
			await get().refreshSessions();
			return meta;
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error) });
			return null;
		}
	},
}));

type Setter = (partial: Partial<MobileState>) => void;
type Getter = () => MobileState;

function attach(connection: Connection, set: Setter, get: Getter): void {
	get().client?.disconnect();
	const client = new SyncClient(connection);

	client.onStateChange((socketState) => {
		set({ socketState });
		if (socketState === "open") {
			const activeSession = get().activeSession;
			if (activeSession) {
				void get().openSession(activeSession);
			}
		}
	});
	client.onEvent((sessionId, event) => applyEvent(sessionId, event, set, get));
	client.connect();
	set({ client });
}

function applyEvent(sessionId: string, event: AgentEvent, set: Setter, get: Getter): void {
	const state = get();

	// If the event belongs to a session in cache but not currently active, keep cache updated
	if (state.activeSession?.id !== sessionId) {
		const cached = state.cache[sessionId];
		if (cached) {
			let cachedMessages = [...cached.messages];
			let cachedToolRuns = { ...cached.toolRuns };

			if (event.type === "message_update") {
				const index = cachedMessages.length - 1;
				if (index >= 0 && cachedMessages[index].role === "assistant") cachedMessages[index] = event.message;
				else cachedMessages.push(event.message);
			} else if (event.type === "message_end") {
				const index = findSlot(cachedMessages, event.message);
				if (index >= 0) cachedMessages[index] = event.message;
				else cachedMessages.push(event.message);
			} else if (event.type === "tool_start") {
				cachedToolRuns[event.toolCallId] = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					summary: event.summary,
					status: "running",
				};
			} else if (event.type === "tool_end") {
				cachedToolRuns[event.toolCallId] = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					summary: cachedToolRuns[event.toolCallId]?.summary ?? event.toolName,
					status: event.isError ? "error" : "done",
					output: event.result.content
						.map((c) => (c.type === "text" ? c.text : "[图片]"))
						.join("\n")
						.slice(0, 4000),
					details: event.result.details,
				};
			}

			set({
				cache: {
					...state.cache,
					[sessionId]: {
						...cached,
						messages: cachedMessages,
						toolRuns: cachedToolRuns,
						updatedAt: Date.now(),
					},
				},
			});
		}

		if (event.type === "title") {
			set({ sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, title: event.title } : s)) });
			return;
		}
		if (event.type === "agent_end") void get().refreshSessions();
		return;
	}

	switch (event.type) {
		case "agent_start":
			set({
				running: true,
				turnTokens: 0,
				turnStartedAt: get().turnStartedAt ?? Date.now(),
			});
			break;

		case "message_start": {
			if (isDuplicateUserEcho(state.messages, event.message)) {
				const messages = [...state.messages];
				messages[messages.length - 1] = event.message;
				set({ messages });
				break;
			}
			set({ messages: [...state.messages, event.message] });
			break;
		}

		case "message_update": {
			const messages = [...state.messages];
			const index = messages.length - 1;
			if (index >= 0 && messages[index].role === "assistant") messages[index] = event.message;
			else messages.push(event.message);
			set({ messages });
			break;
		}

		case "message_end": {
			const messages = [...state.messages];
			const index = findSlot(messages, event.message);
			if (index >= 0) messages[index] = event.message;
			else if (!isDuplicateUserEcho(messages, event.message)) messages.push(event.message);
			set({
				messages,
				turnTokens:
					event.message.role === "assistant" && event.message.usage?.total
						? state.turnTokens + event.message.usage.total
						: state.turnTokens,
			});
			break;
		}

		case "tool_start":
			set({
				toolRuns: {
					...state.toolRuns,
					[event.toolCallId]: {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						summary: event.summary,
						status: "running",
					},
				},
			});
			break;

		case "tool_end":
			set({
				toolRuns: {
					...state.toolRuns,
					[event.toolCallId]: {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						summary: state.toolRuns[event.toolCallId]?.summary ?? event.toolName,
						status: event.isError ? "error" : "done",
						output: event.result.content
							.map((c) => (c.type === "text" ? c.text : "[图片]"))
							.join("\n")
							.slice(0, 4000),
						details: event.result.details,
					},
				},
			});
			break;

		case "approval_request":
			set({
				approvals: [
					...state.approvals,
					{ id: event.requestId, kind: event.kind, title: event.title, detail: event.detail },
				],
			});
			break;

		case "title":
			set({
				activeSession: state.activeSession ? { ...state.activeSession, title: event.title } : state.activeSession,
				sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, title: event.title } : s)),
			});
			break;

		case "rewound":
			// A message was edited elsewhere; the reply it drew no longer follows from what was
			// said, so it goes. Cannot be inferred from the messages that arrive next — the
			// replacement looks like an ordinary new one.
			set({ messages: state.messages.slice(0, event.messageCount), toolRuns: {} });
			break;

		case "agent_end":
			set({ running: false, turnStartedAt: null, turnTokens: 0, approvals: [] });
			void get().refreshSessions();
			break;
	}
}

/** The desktop echoes the prompt we optimistically rendered; match on text to avoid a double bubble. */
function isDuplicateUserEcho(messages: Message[], incoming: Message): boolean {
	if (incoming.role !== "user") return false;
	const incomingText = incoming.content.map((c) => (c.type === "text" ? c.text.trim() : "")).join("");
	if (!incomingText) return false;
	// Only inspect the very latest message if it is an unsynced optimistic user prompt
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return false;
	const lastText = last.content.map((c) => (c.type === "text" ? c.text.trim() : "")).join("");
	return lastText === incomingText;
}

function findSlot(messages: Message[], incoming: Message): number {
	if (incoming.role === "toolResult") {
		return messages.findIndex((m) => m.role === "toolResult" && m.toolCallId === incoming.toolCallId);
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const candidate = messages[i];
		if (candidate.role !== incoming.role) continue;
		if (candidate.role === "assistant" && incoming.role === "assistant") {
			return candidate.stopReason === "pending" || candidate.timestamp === incoming.timestamp ? i : -1;
		}
		if (candidate.timestamp === incoming.timestamp) return i;
	}
	return -1;
}

const MAX_CACHED_SESSIONS = 10;

function trimCache(cache: Record<string, CachedSessionData>): Record<string, CachedSessionData> {
	const entries = Object.entries(cache);
	if (entries.length <= MAX_CACHED_SESSIONS) return cache;
	// Sort by updatedAt descending, keep only the newest N sessions
	entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
	return Object.fromEntries(entries.slice(0, MAX_CACHED_SESSIONS));
}

function rebuildToolRuns(messages: Message[]): Record<string, ToolRun> {
	const runs: Record<string, ToolRun> = {};
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				runs[block.id] = {
					toolCallId: block.id,
					toolName: block.name,
					summary: summarizeToolCall(block.name, block.arguments),
					status: "running",
				};
			}
		} else if (message.role === "toolResult") {
			const run = runs[message.toolCallId];
			if (!run) continue;
			run.status = message.isError ? "error" : "done";
			run.output = message.content
				.map((c) => (c.type === "text" ? c.text : "[图片]"))
				.join("\n")
				.slice(0, 4000);
			run.details = message.details;
		}
	}
	return runs;
}

export function assistantText(message: AssistantMessage, upTo?: number): string {
	const slice = upTo !== undefined ? message.content.slice(0, upTo) : message.content;
	return slice
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
}
