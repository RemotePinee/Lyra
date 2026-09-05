import * as SecureStore from "expo-secure-store";
import { AppState, type AppStateStatus } from "react-native";
import { create } from "zustand";
import { SyncClient, type Connection } from "./client";
import { summarizeToolCall } from "./toolSummary";
import type {
	AgentEvent,
	AssistantMessage,
	Message,
	RemoteSettings,
	SessionMeta,
	TodoItem,
	UserContent,
} from "./protocol";

const CONNECTION_KEY = "lyra.connection";
const CACHE_STORAGE_KEY = "lyra.session_cache";

async function loadCacheFromStorage(): Promise<Record<string, CachedSessionData>> {
	try {
		const raw = await SecureStore.getItemAsync(CACHE_STORAGE_KEY);
		if (!raw) return {};
		return JSON.parse(raw) as Record<string, CachedSessionData>;
	} catch {
		return {};
	}
}

async function saveCacheToStorage(cache: Record<string, CachedSessionData>): Promise<void> {
	try {
		// Limit to 5 most recent sessions and up to 60 messages each to keep SecureStore payload lightweight
		const trimmed: Record<string, CachedSessionData> = {};
		const sorted = Object.entries(cache).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 5);
		for (const [id, data] of sorted) {
			trimmed[id] = {
				...data,
				messages: data.messages.slice(-60),
			};
		}
		await SecureStore.setItemAsync(CACHE_STORAGE_KEY, JSON.stringify(trimmed));
	} catch {
		// Ignore storage quota / secure store issues
	}
}

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
	/** Tracks running/waiting/done activity per session id across the entire workspace. */
	sessionActivities: Record<string, "running" | "waiting" | "done" | "failed">;

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
	renameSession(title: string): Promise<void>;
	archiveSession(session: SessionMeta, archived: boolean): Promise<void>;
	deleteSession(session: SessionMeta): Promise<void>;
	setModel(modelId: string): Promise<void>;
	setThinking(thinking: string): Promise<void>;
	setPermissionMode(mode: string): Promise<void>;
	updateRemoteSettings(patch: Partial<RemoteSettings>): Promise<boolean>;
	fetchUsage(): Promise<import("./usage").UsageScan | null>;
	fetchGitStatus(cwd: string): Promise<import("./protocol").GitStatus | null>;
	listFiles(dir: string): Promise<import("./protocol").RemoteFileEntry[]>;
	readFile(path: string): Promise<import("./protocol").RemoteFileContents | null>;
	catchUp(): Promise<void>;
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
	sessionActivities: {},

	async hydrate() {
		const [rawConnection, initialCache] = await Promise.all([
			SecureStore.getItemAsync(CONNECTION_KEY).catch(() => null),
			loadCacheFromStorage(),
		]);

		if (!rawConnection) {
			set({ hydrated: true, cache: initialCache });
			return;
		}
		try {
			const connection = JSON.parse(rawConnection) as Connection;
			attach(connection, set, get);
			set({ connection, hydrated: true, cache: initialCache });
			void get().refreshSessions();
		} catch {
			set({ hydrated: true, cache: initialCache });
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
			set({ sessions: sessions.sessions, settings });

			// Check live status for the latest sessions in background to seed initial activity state
			const topSessions = sessions.sessions.slice(0, 10);
			void Promise.allSettled(
				topSessions.map(async (s) => {
					try {
						const status = await client.status(s.projectId, s.id);
						if (status.running || status.pendingApprovals?.length > 0) {
							set({
								sessionActivities: {
									...get().sessionActivities,
									[s.id]: status.pendingApprovals?.length > 0 ? "waiting" : "running",
								},
							});
						}
					} catch {}
				}),
			);
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			set({ loadingSessions: false });
		}
	},

	async openSession(meta) {
		const client = get().client;
		if (!client) return;

		// Stale-While-Revalidate: If session exists in cache, load it immediately!
		const cached = get().cache[meta.id];
		const hasCache = !!cached && cached.messages.length > 0;

		if (hasCache) {
			set({
				activeSession: meta,
				messages: cached.messages,
				toolRuns: cached.toolRuns,
				approvals: [],
				seq: cached.seq,
				minSeq: 0,
				hasEarlierMessages: false,
				loadingEarlier: false,
				loadingSessionId: meta.id,
				error: null,
				sessionActivities: {
					...get().sessionActivities,
					...(get().sessionActivities[meta.id] === "done" || get().sessionActivities[meta.id] === "failed"
						? { [meta.id]: undefined as never }
						: {}),
				},
			});
		} else {
			// First-time open: clean state
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
				sessionActivities: {
					...get().sessionActivities,
					...(get().sessionActivities[meta.id] === "done" || get().sessionActivities[meta.id] === "failed"
						? { [meta.id]: undefined as never }
						: {}),
				},
			});
		}

		try {
			// Background revalidate: fetch latest 120 records & status
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
			const nextCache = trimCache({
				...get().cache,
				[meta.id]: {
					messages,
					toolRuns,
					seq,
					updatedAt: Date.now(),
				},
			});
			void saveCacheToStorage(nextCache);

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
				cache: nextCache,
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
			const nextCache = trimCache({
				...cache,
				[activeSession.id]: {
					messages,
					toolRuns,
					seq,
					updatedAt: Date.now(),
				},
			});
			void saveCacheToStorage(nextCache);
			set({
				cache: nextCache,
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
		if (client && activeSession) {
			await client.abort(activeSession.projectId, activeSession.id).catch(() => undefined);
			// Mark all active toolRuns as done immediately
			const updatedToolRuns = { ...get().toolRuns };
			for (const key of Object.keys(updatedToolRuns)) {
				if (updatedToolRuns[key].status === "running") {
					updatedToolRuns[key] = { ...updatedToolRuns[key], status: "done" };
				}
			}
			set({ running: false, turnStartedAt: null, turnTokens: 0, approvals: [], toolRuns: updatedToolRuns });
			void get().catchUp();
		}
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
	async renameSession(title) {
		const { client, activeSession } = get();
		if (!client || !activeSession || !title.trim()) return;
		try {
			const res = await client.rename(activeSession.projectId, activeSession.id, title.trim());
			if (res.ok) {
				set({
					activeSession: { ...activeSession, title: title.trim() },
					sessions: get().sessions.map((s) => (s.id === activeSession.id ? { ...s, title: title.trim() } : s)),
				});
			}
		} catch {
			// ignore rename errors
		}
	},

	async archiveSession(session, archived) {
		const client = get().client;
		if (!client) return;
		try {
			await client.setArchived(session.projectId, session.id, archived);
			set({
				sessions: get().sessions.map((s) => (s.id === session.id ? { ...s, archived } : s)),
			});
		} catch {
			// ignore error
		}
	},

	async deleteSession(session) {
		const client = get().client;
		if (!client) return;
		try {
			await client.removeSession(session.projectId, session.id);
			set({
				sessions: get().sessions.filter((s) => s.id !== session.id),
			});
		} catch {
			// ignore error
		}
	},

	async setModel(modelId) {
		const { client, activeSession, messages } = get();
		if (!client || !activeSession) return;
		const midConversation = messages.length > 0 && activeSession.modelId !== modelId;
		const result = await client
			.setModel(activeSession.projectId, activeSession.id, modelId)
			.catch(() => null);
		if (!result?.ok) return;
		set({ activeSession: { ...activeSession, modelId } });
		if (midConversation) {
			// Align with desktop turn-slice.ts warning toast/alert
			set({
				error: "已切换模型。之前的推理上下文无法跨模型沿用，接下来的回答可能变差；重开一个对话效果最好。",
			});
		}
	},

	async setThinking(thinking: string) {
		const { client, activeSession, settings } = get();
		if (!client || !activeSession) return;
		const res = await client.setThinking(activeSession.id, thinking).catch(() => null);
		if (res?.ok) {
			set({
				activeSession: { ...activeSession, thinking },
			});
			if (settings && thinking !== "off") {
				void client.saveSettings({ lastThinking: thinking } as never);
			}
		}
	},

	async setPermissionMode(mode: string) {
		const { client, settings } = get();
		if (!client || !settings) return;
		const res = await client.saveSettings({ permissionMode: mode }).catch(() => null);
		if (res?.ok) {
			set({
				settings: { ...settings, permissionMode: mode },
			});
		}
	},

	async updateRemoteSettings(patch: Partial<RemoteSettings>) {
		const { client, settings } = get();
		if (!client || !settings) return false;
		const res = await client.saveSettings(patch).catch(() => null);
		if (res?.ok) {
			set({
				settings: { ...settings, ...patch },
			});
			return true;
		}
		return false;
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

	async fetchUsage() {
		const client = get().client;
		if (!client) return null;
		try {
			return await client.scanUsage();
		} catch {
			return null;
		}
	},

	async fetchGitStatus(cwd: string) {
		const client = get().client;
		if (!client) return null;
		try {
			return await client.gitStatus(cwd);
		} catch {
			return null;
		}
	},

	async listFiles(dir: string) {
		const client = get().client;
		if (!client) return [];
		try {
			return await client.listFiles(dir);
		} catch {
			return [];
		}
	},

	async readFile(path: string) {
		const client = get().client;
		if (!client) return null;
		try {
			return await client.readFile(path);
		} catch {
			return null;
		}
	},

	/**
	 * Silent incremental catch-up on reconnect or app foreground resume.
	 * Fetches only missing records since current `seq` without tearing down UI or showing loading spinners.
	 */
	async catchUp() {
		const { client, activeSession, seq: currentSeq, messages: currentMessages } = get();
		if (!client || !activeSession) return;

		try {
			const [res, status] = await Promise.all([
				client.records(activeSession.projectId, activeSession.id, { since: currentSeq }),
				client.status(activeSession.projectId, activeSession.id).catch(() => null),
			]);

			if (res.records.length === 0 && !status) return;

			let nextSeq = currentSeq;
			const newEntries: { seq: number; message: Message }[] = [];
			let truncated = false;
			let afterSeq = 0;

			for (const record of res.records) {
				nextSeq = Math.max(nextSeq, record.seq);
				if (record.type === "message") {
					newEntries.push({ seq: record.seq, message: record.message });
				} else if (record.type === "truncate") {
					truncated = true;
					afterSeq = record.afterSeq;
				}
			}

			let updatedMessages = currentMessages;
			if (truncated) {
				updatedMessages = updatedMessages.slice(0, afterSeq);
			}

			if (newEntries.length > 0) {
				const merged = [...updatedMessages];
				for (const item of newEntries) {
					// Avoid duplicate bubble if message already exists
					const exists = findSlot(merged, item.message);
					if (exists >= 0) {
						merged[exists] = item.message;
					} else {
						merged.push(item.message);
					}
				}
				updatedMessages = merged;
			}

			const toolRuns = rebuildToolRuns(updatedMessages);
			const isRunning = status?.running ?? false;

			set({
				messages: updatedMessages,
				toolRuns,
				seq: nextSeq,
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
		} catch {
			// Silent background catch-up failure should not interrupt user UI
		}
	},
}));

type Setter = (partial: Partial<MobileState>) => void;
type Getter = () => MobileState;

let appStateSubscription: { remove: () => void } | null = null;

function attach(connection: Connection, set: Setter, get: Getter): void {
	get().client?.disconnect();
	if (appStateSubscription) {
		appStateSubscription.remove();
		appStateSubscription = null;
	}

	const client = new SyncClient(connection);

	client.onStateChange((socketState) => {
		set({ socketState });
		if (socketState === "open") {
			const activeSession = get().activeSession;
			if (activeSession) {
				// If session already mounted with messages, silently catch up missing delta
				// rather than flashing a full-screen loading spinner
				if (get().messages.length > 0 && get().seq > 0) {
					void get().catchUp();
				} else {
					void get().openSession(activeSession);
				}
			}
		}
	});

	client.onEvent((sessionId, event) => applyEvent(sessionId, event, set, get));
	client.connect();
	set({ client });

	// Listen for OS foreground resume event: immediately ping/reconnect WebSocket
	appStateSubscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
		if (nextState === "active") {
			client.reconnectNow();
			const activeSession = get().activeSession;
			if (activeSession && get().messages.length > 0) {
				void get().catchUp();
			}
		}
	});
}

let updateFlushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingMessageUpdates: { sessionId: string; message: Message } | null = null;

function flushPendingMessageUpdate(set: Setter, get: Getter): void {
	if (updateFlushTimer) {
		clearTimeout(updateFlushTimer);
		updateFlushTimer = null;
	}
	if (!pendingMessageUpdates) return;

	const { sessionId, message } = pendingMessageUpdates;
	pendingMessageUpdates = null;

	const state = get();
	if (state.activeSession?.id !== sessionId) return;

	const messages = [...state.messages];
	const index = messages.length - 1;
	if (index >= 0 && messages[index].role === "assistant") {
		messages[index] = message;
	} else {
		messages.push(message);
	}
	set({ messages });
}

function applyEvent(sessionId: string, event: AgentEvent, set: Setter, get: Getter): void {
	const state = get();

	// Track global session activity across the entire app
	const currentActivity = state.sessionActivities[sessionId] ?? null;
	let nextAct: "running" | "waiting" | "done" | "failed" | null = currentActivity;
	if (event.type === "agent_start" || event.type === "turn_start") {
		nextAct = "running";
	} else if (event.type === "approval_request") {
		nextAct = "waiting";
	} else if (event.type === "tool_start" || event.type === "message_start" || event.type === "message_update") {
		if (currentActivity === "waiting") nextAct = "running";
	} else if (event.type === "agent_end") {
		if (event.reason === "error" || event.reason === "max_turns") {
			nextAct = "failed";
		} else if (event.reason === "aborted") {
			nextAct = null;
		} else {
			nextAct = "done";
		}
	}
	if (nextAct !== currentActivity) {
		const nextActivities = { ...state.sessionActivities };
		if (nextAct === null) {
			delete nextActivities[sessionId];
		} else {
			nextActivities[sessionId] = nextAct;
		}
		set({ sessionActivities: nextActivities });
	}

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
			flushPendingMessageUpdate(set, get);
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
			// Backpressure protection: buffer rapid-fire stream updates into ~40ms batches
			// to avoid thousands of React Yoga layout re-computations and UI queue starvation.
			pendingMessageUpdates = { sessionId, message: event.message };
			if (!updateFlushTimer) {
				updateFlushTimer = setTimeout(() => {
					flushPendingMessageUpdate(set, get);
				}, 40);
			}
			break;
		}

		case "message_end": {
			// Immediately flush any buffered streaming text so mobile instant-syncs with desktop
			flushPendingMessageUpdate(set, get);
			const messages = [...get().messages];
			const index = findSlot(messages, event.message);
			if (index >= 0) messages[index] = event.message;
			else if (!isDuplicateUserEcho(messages, event.message)) messages.push(event.message);
			set({
				messages,
				turnTokens:
					event.message.role === "assistant" && event.message.usage?.total
						? get().turnTokens + event.message.usage.total
						: get().turnTokens,
			});
			break;
		}

		case "tool_start":
			flushPendingMessageUpdate(set, get);
			set({
				toolRuns: {
					...get().toolRuns,
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
			flushPendingMessageUpdate(set, get);
			set({
				toolRuns: {
					...get().toolRuns,
					[event.toolCallId]: {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						summary: get().toolRuns[event.toolCallId]?.summary ?? event.toolName,
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
			flushPendingMessageUpdate(set, get);
			set({
				approvals: [
					...get().approvals,
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
			flushPendingMessageUpdate(set, get);
			// A message was edited elsewhere; the reply it drew no longer follows from what was
			// said, so it goes. Cannot be inferred from the messages that arrive next — the
			// replacement looks like an ordinary new one.
			set({ messages: get().messages.slice(0, event.messageCount), toolRuns: {} });
			break;

		case "agent_end": {
			flushPendingMessageUpdate(set, get);
			const finishedToolRuns = { ...get().toolRuns };
			for (const key of Object.keys(finishedToolRuns)) {
				if (finishedToolRuns[key].status === "running") {
					finishedToolRuns[key] = { ...finishedToolRuns[key], status: "done" };
				}
			}
			set({ running: false, turnStartedAt: null, turnTokens: 0, approvals: [], toolRuns: finishedToolRuns });
			void get().refreshSessions();
			break;
		}
	}
}

/** The desktop echoes the prompt we optimistically rendered; match on text to avoid a double bubble. */
function isDuplicateUserEcho(messages: Message[], incoming: Message): boolean {
	if (incoming.role !== "user") return false;
	// Only inspect the very latest message if it is an unsynced optimistic user prompt
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return false;

	const incomingText = incoming.content.map((c) => (c.type === "text" ? c.text.trim() : "")).join("");
	const lastText = last.content.map((c) => (c.type === "text" ? c.text.trim() : "")).join("");
	if (incomingText !== lastText) return false;

	// For image-only messages (no text), compare image count to avoid false negatives
	const incomingImages = incoming.content.filter((c) => c.type === "image").length;
	const lastImages = last.content.filter((c) => c.type === "image").length;
	if (incomingImages !== lastImages) return false;

	// At least text or images must match to be considered a duplicate
	return incomingText.length > 0 || incomingImages > 0;
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
			const isMsgDone = message.stopReason !== "pending";
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				runs[block.id] = {
					toolCallId: block.id,
					toolName: block.name,
					summary: summarizeToolCall(block.name, block.arguments),
					status: isMsgDone ? "done" : "running",
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

export function todosFrom(messages: Message[]): TodoItem[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "toolResult" || message.toolName !== "todo_write" || message.isError) continue;
		const details = message.details as { kind?: string; todos?: TodoItem[] } | undefined;
		if (details?.kind === "todo" && Array.isArray(details.todos)) return details.todos;
	}
	return [];
}
