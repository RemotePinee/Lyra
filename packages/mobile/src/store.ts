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

let saveCacheTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSaveCache: Record<string, CachedSessionData> | null = null;

async function flushSaveCache(): Promise<void> {
	if (!pendingSaveCache) return;
	const cache = pendingSaveCache;
	pendingSaveCache = null;
	try {
		const trimmed: Record<string, CachedSessionData> = {};
		const sorted = Object.entries(cache).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 10);
		for (const [id, data] of sorted) {
			trimmed[id] = {
				...data,
				messages: data.messages.slice(-80),
			};
		}
		await SecureStore.setItemAsync(CACHE_STORAGE_KEY, JSON.stringify(trimmed));
	} catch {
		// Ignore storage quota / secure store issues
	}
}

function scheduleSaveCacheToStorage(cache: Record<string, CachedSessionData>): void {
	pendingSaveCache = cache;
	if (saveCacheTimer) clearTimeout(saveCacheTimer);
	saveCacheTimer = setTimeout(() => {
		saveCacheTimer = null;
		void flushSaveCache();
	}, 1500);
}
export async function saveCacheToStorage(cache: Record<string, CachedSessionData>): Promise<void> {
	scheduleSaveCacheToStorage(cache);
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
	minSeq?: number;
	hasEarlier?: boolean;
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
	pair(connection: Connection): Promise<{ ok: boolean; reason?: string }>;
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
	retryFrom(index: number): Promise<void>;
	resume(): Promise<void>;
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

	async pair(connection): Promise<{ ok: boolean; reason?: string }> {
		// Disconnect existing client first so old socket doesn't hold room on relay
		get().client?.disconnect();
		const client = new SyncClient(connection);
		const verification = await client.verify();
		if (!verification.ok) {
			client.disconnect();
			const reason = verification.reason || "地址或令牌不正确，请检查桌面端的「移动端同步」页面。";
			set({ error: reason });
			return { ok: false, reason };
		}
		// Keychain writes can fail (locked device, web preview); pairing should still work
		// for the current session rather than dropping the user back to the pairing screen.
		await SecureStore.setItemAsync(CONNECTION_KEY, JSON.stringify(connection)).catch(() => undefined);
		attach(connection, set, get, client);
		set({ connection, error: null, socketState: "open" });
		await get().refreshSessions();
		return { ok: true };
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
						const isRunning = status.running || (status.pendingApprovals?.length ?? 0) > 0;
						if (isRunning) {
							set({
								sessionActivities: {
									...get().sessionActivities,
									[s.id]: (status.pendingApprovals?.length ?? 0) > 0 ? "waiting" : "running",
								},
							});
							// Do not fetch records eagerly for all running sessions in background list refresh
							// Records are fetched on-demand when user actually enters the session
						}
					} catch {
						// ignore background status fail
					}
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
		const cached = get().cache[meta.id];
		const hasCache = !!cached && cached.messages.length > 0;
		const knownActivity = get().sessionActivities[meta.id];
		const isInitialRunning = knownActivity === "running";
		if (hasCache) {
			const isInitialRunning = knownActivity === "running";
			// Render immediately so user sees something while verifying
			set({
				activeSession: meta,
				messages: cached.messages,
				toolRuns: cached.toolRuns,
				approvals: [],
				running: isInitialRunning,
				seq: cached.seq,
				minSeq: cached.minSeq ?? 0,
				hasEarlierMessages: cached.hasEarlier ?? false,
				loadingEarlier: false,
				loadingSessionId: null,
				error: null,
			});
		} else {
			// First-time open (no cache): clean loading state
			const knownActivity = get().sessionActivities[meta.id];
			const isInitialRunning = knownActivity === "running";
			set({
				activeSession: meta,
				messages: [],
				toolRuns: {},
				approvals: [],
				running: isInitialRunning,
				turnStartedAt: isInitialRunning ? Date.now() : null,
				turnTokens: 0,
				seq: 0,
				minSeq: 0,
				hasEarlierMessages: false,
				loadingEarlier: false,
				loadingSessionId: meta.id,
				error: null,
			});
		}

		try {
			// 1. Immediately fetch ground truth status from desktop
			let status = null;
			try {
				status = await client.status(meta.projectId, meta.id);
			} catch {
				status = null;
			}

			const serverRunning = typeof status?.running === "boolean" ? status.running : isInitialRunning;
			const serverPendingApprovals = status?.pendingApprovals ?? [];
			const serverMeta = status?.meta ?? meta;
			const serverSeq = serverMeta.seq ?? 0;

			// Immediately reflect real running / approval status in UI
			const liveActivities = { ...get().sessionActivities };
			if (serverRunning) {
				liveActivities[meta.id] = serverPendingApprovals.length > 0 ? "waiting" : "running";
			} else if (liveActivities[meta.id] === "running" || liveActivities[meta.id] === "waiting") {
				delete liveActivities[meta.id];
			}

			set({
				activeSession: { ...meta, ...serverMeta },
				running: serverRunning,
				turnStartedAt: serverRunning ? (get().turnStartedAt ?? Date.now()) : null,
				sessionActivities: liveActivities,
				approvals: serverPendingApprovals.map((p) => ({
					id: p.id,
					kind: p.request.kind,
					title: p.request.title,
					detail: p.request.detail,
				})),
			});

			// 2. Check cache freshness against authoritative server sequence
			const cachedSeq = cached?.seq ?? 0;
			const isUpToDate =
				hasCache &&
				!serverRunning &&
				cachedSeq >= serverSeq &&
				cached.messages.length > 0 &&
				(serverMeta.updatedAt ? (cached.updatedAt ?? 0) >= serverMeta.updatedAt : true);

			if (isUpToDate) {
				set({ loadingSessionId: null });
				return;
			}

			// 3. Delta or tail fetch:
			// If cache exists and server sequence moved forward incrementally (<= 200 delta),
			// fetch ONLY the delta since cachedSeq!
			const canFetchDelta = hasCache && cachedSeq > 0 && serverSeq >= cachedSeq && serverSeq - cachedSeq <= 200;
			const fetchPromise = canFetchDelta
				? client.records(meta.projectId, meta.id, { since: cachedSeq })
				: client.records(meta.projectId, meta.id, { tail: 12 });

			const res = await Promise.race([
				fetchPromise,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("同步超时")), 15000)),
			]);
			let entries: { seq: number; message: Message }[] = [];
			let seq = cachedSeq;
			let minSeq = Infinity;

			for (const record of res.records) {
				seq = Math.max(seq, record.seq);
				minSeq = Math.min(minSeq, record.seq);
				if (record.type === "message") entries.push({ seq: record.seq, message: record.message });
				else if (record.type === "truncate") entries = entries.filter((e) => e.seq <= record.afterSeq);
			}
			const fetchedMessages = entries.map((e) => e.message);

			let finalMessages: Message[];
			if (canFetchDelta) {
				// Incremental delta: append new messages directly onto cached list
				finalMessages = [...cached.messages, ...fetchedMessages];
				minSeq = cached.minSeq ?? (minSeq === Infinity ? 0 : minSeq);
			} else {
				// Tail fetch: fetchedMessages is a fresh, contiguous tail window.
				// NEVER splice an older disconnected cache head onto this tail unless
				// we verify sequence continuity (i.e. cache is contiguous with the tail).
				finalMessages = fetchedMessages;
				if (minSeq === Infinity) {
					minSeq = 0;
				}
			}

			const current = get();
			// If the user navigated away from this session while fetch was in flight, discard state update
			if (current.activeSession?.id !== meta.id) return;

			// If session is active and live messages already arrived during the fetch, merge them safely
			if (current.messages.length > 0) {
				const currentLast = current.messages[current.messages.length - 1];
				const fetchedLast = finalMessages[finalMessages.length - 1];
				if (
					current.messages.length >= finalMessages.length &&
					currentLast?.role === "assistant" &&
					fetchedLast?.role === "assistant"
				) {
					finalMessages = [...finalMessages.slice(0, -1), currentLast];
				}
			}
			const toolRuns = rebuildToolRuns(finalMessages);

			const nextCache = trimCache({
				...get().cache,
				[meta.id]: {
					messages: finalMessages,
					toolRuns,
					seq,
					minSeq: minSeq === Infinity ? (cached?.minSeq ?? 0) : minSeq,
					hasEarlier: typeof cached?.hasEarlier === "boolean" ? cached.hasEarlier : Boolean(res.hasEarlier),
					updatedAt: Date.now(),
				},
			});
			void saveCacheToStorage(nextCache);

			set({
				messages: finalMessages,
				seq,
				minSeq: minSeq === Infinity ? 0 : minSeq,
				hasEarlierMessages: canFetchDelta ? (cached?.hasEarlier ?? false) : Boolean(res.hasEarlier),
				toolRuns,
				loadingSessionId: null,
				cache: nextCache,
			});
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error), loadingSessionId: null });
		}
	},

	async loadEarlierMessages() {
		const { client, activeSession, minSeq, loadingEarlier, hasEarlierMessages, messages: currentMessages } = get();
		if (!client || !activeSession || loadingEarlier || !hasEarlierMessages) return;
		if (minSeq <= 1) {
			set({ hasEarlierMessages: false, loadingEarlier: false });
			return;
		}
		set({ loadingEarlier: true });
		try {
			// Fetch 12 dialogue units strictly before the current earliest sequence
			const res = await client.records(activeSession.projectId, activeSession.id, { before: minSeq, tail: 12 });
			let entries: { seq: number; message: Message }[] = [];
			let nextMinSeq = minSeq;

			for (const record of res.records) {
				nextMinSeq = Math.min(nextMinSeq, record.seq);
				if (record.type === "message") entries.push({ seq: record.seq, message: record.message });
				else if (record.type === "truncate") entries = entries.filter((e) => e.seq <= record.afterSeq);
			}
			const earlierMessages = entries.map((e) => e.message);
			// Deduplicate by message key: user/ast timestamp and role or tool call ID
			const seenMsgKeys = new Set<string>();
			const deduplicatedMessages: Message[] = [];
			for (const m of [...earlierMessages, ...currentMessages]) {
				let key = `${m.role}-${m.timestamp}`;
				if (m.role === "toolResult") {
					key = `tr-${m.toolCallId}`;
				} else if (m.role === "user") {
					// Include content snippet in case multiple user messages share a timestamp
					const txt = m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
					key = `user-${m.timestamp}-${txt.slice(0, 30)}`;
				}
				if (!seenMsgKeys.has(key)) {
					seenMsgKeys.add(key);
					deduplicatedMessages.push(m);
				}
			}
			const mergedMessages = deduplicatedMessages;
			const toolRuns = rebuildToolRuns(mergedMessages);
			set({
				messages: mergedMessages,
				minSeq: nextMinSeq,
				hasEarlierMessages: Boolean(res.hasEarlier) && res.records.length > 0 && nextMinSeq > 1,
				toolRuns,
				loadingEarlier: false,
			});
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error), loadingEarlier: false, hasEarlierMessages: false });
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
					minSeq: get().minSeq,
					hasEarlier: get().hasEarlierMessages,
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
			// Optimistically abort immediately for instant UI feedback (0ms perceived lag)
			const updatedToolRuns = { ...get().toolRuns };
			for (const key of Object.keys(updatedToolRuns)) {
				if (updatedToolRuns[key].status === "running") {
					updatedToolRuns[key] = { ...updatedToolRuns[key], status: "done" };
				}
			}
			const nextActivities = { ...get().sessionActivities };
			delete nextActivities[activeSession.id];
			set({
				running: false,
				turnStartedAt: null,
				turnTokens: 0,
				approvals: [],
				toolRuns: updatedToolRuns,
				sessionActivities: nextActivities,
			});

			await client.abort(activeSession.projectId, activeSession.id).catch(() => undefined);
			void get().catchUp();
		}
	},

	async approve(id, decision) {
		const { client, activeSession } = get();
		if (!client || !activeSession) return;
		set({ approvals: get().approvals.filter((a) => a.id !== id) });
		await client.approve(activeSession.projectId, activeSession.id, id, decision).catch(() => undefined);
	},

	async retryFrom(index: number) {
		const { client, activeSession, messages } = get();
		if (!client || !activeSession || get().running) return;

		let targetUserIndex = -1;
		for (let i = Math.min(index, messages.length - 1); i >= 0; i--) {
			const m = messages[i];
			if (m.role === "user" && !m.synthetic) {
				targetUserIndex = i;
				break;
			}
		}
		if (targetUserIndex === -1) return;

		const targetMsg = messages[targetUserIndex];
		if (targetMsg.role !== "user") return;
		const optimisticMessages: Message[] = [
			...messages.slice(0, targetUserIndex),
			{ role: "user", content: targetMsg.content, timestamp: Date.now() },
		];

		set({
			messages: optimisticMessages,
			toolRuns: {},
			approvals: [],
			running: true,
			turnStartedAt: Date.now(),
			turnTokens: 0,
		});

		try {
			await client.editMessage(activeSession.id, targetUserIndex, targetMsg.content);
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error), running: false });
		}
	},

	async resume() {
		const { send } = get();
		await send("继续从中断的地方接着做。");
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

function attach(connection: Connection, set: Setter, get: Getter, existingClient?: SyncClient): void {
	if (existingClient) {
		const current = get().client;
		if (current && current !== existingClient) {
			current.disconnect();
		}
	} else {
		get().client?.disconnect();
	}
	if (appStateSubscription) {
		appStateSubscription.remove();
		appStateSubscription = null;
	}

	const client = existingClient ?? new SyncClient(connection);

	client.onStateChange((socketState) => {
		set({ socketState });
		if (socketState === "open") {
			// Clear any transient disconnection errors and auto-refresh sessions/settings
			set({ error: null });
			void get().refreshSessions();

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
	if (!existingClient) {
		client.connect();
	}
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

let updateFlushTimer: number | ReturnType<typeof setTimeout> | null = null;
let pendingMessageUpdates: { sessionId: string; message: Message } | null = null;

function flushPendingMessageUpdate(set: Setter, get: Getter): void {
	if (updateFlushTimer !== null) {
		if (typeof cancelAnimationFrame === "function") {
			cancelAnimationFrame(updateFlushTimer as number);
		} else {
			clearTimeout(updateFlushTimer as ReturnType<typeof setTimeout>);
		}
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

	// If the event belongs to a session not currently active, DO NOT mutate its cached message array.
	// Blindly appending messages in background causes severe history fragmentation/gaps
	// when intermediate turns are skipped.
	if (state.activeSession?.id !== sessionId) {
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
			pendingMessageUpdates = { sessionId, message: event.message };
			if (updateFlushTimer === null) {
				if (typeof requestAnimationFrame === "function") {
					updateFlushTimer = requestAnimationFrame(() => {
						updateFlushTimer = null;
						flushPendingMessageUpdate(set, get);
					});
				} else {
					updateFlushTimer = setTimeout(() => {
						updateFlushTimer = null;
						flushPendingMessageUpdate(set, get);
					}, 16);
				}
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
	if (incoming.role === "assistant") {
		const incomingCallIds = incoming.content
			.filter((c): c is Extract<AssistantMessage["content"][number], { type: "toolCall" }> => c.type === "toolCall")
			.map((c) => c.id);
		if (incomingCallIds.length > 0) {
			const byTool = messages.findLastIndex(
				(m) =>
					m.role === "assistant" &&
					m.content.some((c) => c.type === "toolCall" && incomingCallIds.includes(c.id)),
			);
			if (byTool >= 0) return byTool;
		}

		for (let i = messages.length - 1; i >= 0; i--) {
			const candidate = messages[i];
			if (candidate.role !== "assistant") continue;
			if (candidate.stopReason === "pending") return i;
			if (candidate.timestamp === incoming.timestamp) return i;
		}
		return -1;
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const candidate = messages[i];
		if (candidate.role === incoming.role && candidate.timestamp === incoming.timestamp) return i;
	}
	return -1;
}

const MAX_CACHED_SESSIONS = 25;

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
