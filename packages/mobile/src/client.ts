/**
 * Client for the desktop sync server.
 *
 * Supports two operating modes transparently:
 * 1. Direct (LAN / Reverse Proxy): HTTP for REST calls, WebSocket for real-time events.
 * 2. Relay Tunnel (Remote NAT traversal): Single multiplexed WebSocket connection
 *    handling both RPC requests and broadcast agent events with zero HTTP dependency.
 */

import type { AgentEvent, RemoteSettings, SessionMeta, SessionRecord, UserContent } from "./protocol";
import { sha256 } from "./sha256";

export interface Connection {
	host: string;
	port: number;
	token: string;
	secure?: boolean;
	relay?: boolean;
}

interface PendingRpc {
	resolve: (val: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class SyncClient {
	private connection: Connection;
	private socket: WebSocket | null = null;
	private listeners = new Set<(sessionId: string, event: AgentEvent) => void>();
	private stateListeners = new Set<(state: "connecting" | "open" | "closed") => void>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private closedByUser = false;

	// In-flight WebSocket RPC promises indexed by request id
	private pendingRpcs = new Map<string, PendingRpc>();
	private rpcSeq = 0;

	constructor(connection: Connection) {
		this.connection = connection;
	}

	get isRelay(): boolean {
		return Boolean(this.connection.relay);
	}

	private get isHttps(): boolean {
		if (typeof this.connection.secure === "boolean") return this.connection.secure;
		return /^https:\/\//i.test(this.connection.host);
	}

	get baseUrl(): string {
		const cleanHost = this.connection.host.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/:\d+$/, "").trim();
		const proto = this.isHttps ? "https" : "http";
		return `${proto}://${cleanHost}:${this.connection.port}`;
	}

	// -------------------------------------------------------------------------
	// Unified Request / RPC Dispatcher
	// -------------------------------------------------------------------------

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		if (this.isRelay) {
			throw new Error("Cannot make direct HTTP request in relay mode. Use WebSocket RPC instead.");
		}

		const response = await fetch(`${this.baseUrl}${path}`, {
			...init,
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${this.connection.token}`,
				...init.headers,
			},
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
		}
		return (await response.json()) as T;
	}

	/**
	 * Send an RPC call over the active WebSocket connection.
	 * Used for all data operations in relay mode, and for extended methods (git, files) in direct mode.
	 */
	async sendRpc<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			if (this.isRelay) {
				// In relay mode, trigger reconnect and wait briefly for tunnel to be open
				this.connect();
				await new Promise<void>((resolve, reject) => {
					if (this.currentState === "open") return resolve();
					const timer = setTimeout(() => {
						cleanup();
						reject(new Error("中转通道未就绪 (等待超时)"));
					}, 5000);
					const cleanup = this.onStateChange((state) => {
						if (state === "open") {
							clearTimeout(timer);
							cleanup();
							resolve();
						} else if (state === "closed") {
							clearTimeout(timer);
							cleanup();
							reject(new Error("中转连接已断开"));
						}
					});
				});
			} else {
				throw new Error("WebSocket is not connected");
			}
		}

		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			throw new Error("WebSocket is not connected");
		}

		return new Promise<T>((resolve, reject) => {
			const id = `rpc-${++this.rpcSeq}-${Date.now().toString(36)}`;
			const timer = setTimeout(() => {
				this.pendingRpcs.delete(id);
				reject(new Error(`RPC timeout (${method})`));
			}, 20000);

			this.pendingRpcs.set(id, {
				resolve: (val) => resolve(val as T),
				reject,
				timer,
			});

			this.socket?.send(
				JSON.stringify({
					type: "rpc",
					id,
					method,
					args,
				}),
			);
		});
	}

	static async ping(host: string, port: number): Promise<{ ok: boolean; reason?: string; secure?: boolean }> {
		const cleanHost = host.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/:\d+$/, "").trim();
		const isExplicitHttps = /^https:\/\//i.test(host);

		const probe = async (proto: "https" | "http") => {
			try {
				const response = await fetch(`${proto}://${cleanHost}:${port}/api/ping`, {
					signal: AbortSignal.timeout(4000),
				});
				if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
				const body = (await response.json()) as { app?: string };
				return { ok: body.app === "lyra", reason: body.app !== "lyra" ? "不是 Lyra 服务" : undefined, secure: proto === "https" };
			} catch (e) {
				return { ok: false, reason: e instanceof Error ? e.message : String(e) };
			}
		};

		if (isExplicitHttps) {
			return probe("https");
		}

		const httpRes = await probe("http");
		if (httpRes.ok) return httpRes;

		const httpsRes = await probe("https");
		if (httpsRes.ok) return httpsRes;

		return httpRes.reason ? httpRes : httpsRes;
	}

	async verify(): Promise<{ ok: boolean; reason?: string }> {
		try {
			if (this.isRelay) {
				// In relay mode, ensure WebSocket is connected and ready before sending RPC
				this.connect();
				if (this.currentState !== "open") {
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(() => {
							cleanup();
							reject(new Error("中转握手超时(桌面端未连入同房间或中继服务不可达)"));
						}, 10000);
						const cleanup = this.onStateChange((state) => {
							if (state === "open") {
								clearTimeout(timer);
								cleanup();
								resolve();
							} else if (state === "closed") {
								clearTimeout(timer);
								cleanup();
								reject(new Error(`中转连接被关闭: ${this.lastCloseError || "网络中断或被拒绝"}`));
							}
						});
					});
				}
			}
			const res = await this.listSessions();
			const ok = Boolean(res && Array.isArray(res.sessions));
			return { ok, reason: ok ? undefined : "获取会话列表失败" };
		} catch (err) {
			return { ok: false, reason: err instanceof Error ? err.message : String(err) };
		}
	}

	// -------------------------------------------------------------------------
	// Core Session API (Transparently routed to HTTP or WebSocket RPC)
	// -------------------------------------------------------------------------

	async listSessions(): Promise<{ sessions: SessionMeta[] }> {
		if (this.isRelay) {
			const res = await this.sendRpc<{ sessions?: SessionMeta[] } | SessionMeta[]>("sessions.list");
			if (Array.isArray(res)) return { sessions: res };
			return { sessions: res?.sessions ?? [] };
		}
		return this.request("/api/sessions");
	}

	async settings(): Promise<RemoteSettings> {
		if (this.isRelay) {
			return this.sendRpc<RemoteSettings>("settings.get");
		}
		return this.request("/api/settings");
	}

	async records(
		projectId: string,
		sessionId: string,
		options?: { since?: number; before?: number; limit?: number; tail?: number },
	): Promise<{ records: SessionRecord[]; total?: number; hasEarlier?: boolean }> {
		if (this.isRelay) {
			return this.sendRpc("sessions.records", [projectId, sessionId, options]);
		}
		const params = new URLSearchParams();
		if (typeof options?.since === "number") params.set("since", String(options.since));
		if (typeof options?.before === "number") params.set("before", String(options.before));
		if (typeof options?.limit === "number") params.set("limit", String(options.limit));
		if (typeof options?.tail === "number") params.set("tail", String(options.tail));
		const qs = params.toString();
		return this.request(`/api/sessions/${projectId}/${sessionId}${qs ? `?${qs}` : ""}`);
	}

	async status(projectId: string, sessionId: string): Promise<{
		meta: SessionMeta;
		running: boolean;
		pendingApprovals: { id: string; request: { kind: string; title: string; detail: string } }[];
	}> {
		if (this.isRelay) {
			return this.sendRpc("sessions.status", [projectId, sessionId]);
		}
		return this.request(`/api/sessions/${projectId}/${sessionId}/status`);
	}

	async prompt(projectId: string, sessionId: string, content: UserContent[]): Promise<{ accepted: boolean }> {
		if (this.isRelay) {
			await this.sendRpc("agent.prompt", [sessionId, content]);
			return { accepted: true };
		}
		return this.request(`/api/sessions/${projectId}/${sessionId}/prompt`, {
			method: "POST",
			body: JSON.stringify({ content }),
		});
	}

	async editMessage(sessionId: string, index: number, content: UserContent[]): Promise<{ ok: boolean }> {
		if (this.isRelay) {
			await this.sendRpc("agent.editMessage", [sessionId, index, content]);
			return { ok: true };
		}
		return this.rpc("agent.editMessage", [sessionId, index, content]);
	}

	async abort(projectId: string, sessionId: string): Promise<{ aborted: boolean }> {
		if (this.isRelay) {
			await this.sendRpc("agent.abort", [sessionId]);
			return { aborted: true };
		}
		return this.request(`/api/sessions/${projectId}/${sessionId}/abort`, { method: "POST" });
	}

	async approve(
		projectId: string,
		sessionId: string,
		requestId: string,
		decision: "once" | "always" | "reject",
	): Promise<{ resolved: boolean }> {
		if (this.isRelay) {
			await this.sendRpc("agent.approve", [sessionId, requestId, decision]);
			return { resolved: true };
		}
		return this.request(`/api/sessions/${projectId}/${sessionId}/approve`, {
			method: "POST",
			body: JSON.stringify({ requestId, decision }),
		});
	}

	async setModel(projectId: string, sessionId: string, modelId: string): Promise<{ ok: boolean }> {
		if (this.isRelay) {
			await this.sendRpc("agent.setModel", [sessionId, modelId]);
			return { ok: true };
		}
		return this.request(`/api/sessions/${projectId}/${sessionId}/model`, {
			method: "POST",
			body: JSON.stringify({ modelId }),
		});
	}

	setThinking(sessionId: string, thinking: string): Promise<{ ok: boolean }> {
		return this.rpc("agent.setThinking", [sessionId, thinking]);
	}

	saveSettings(settings: Partial<import("./protocol").RemoteSettings>): Promise<{ ok: boolean }> {
		return this.rpc("settings.save", [settings]);
	}

	async rename(projectId: string, sessionId: string, title: string): Promise<{ ok: boolean; meta: SessionMeta }> {
		if (this.isRelay) {
			const meta = await this.sendRpc<SessionMeta>("sessions.rename", [projectId, sessionId, title]);
			return { ok: true, meta };
		}
		return this.request(`/api/sessions/${projectId}/${sessionId}/rename`, {
			method: "POST",
			body: JSON.stringify({ title }),
		});
	}

	async createSession(cwd: string, modelId?: string): Promise<{ meta: SessionMeta }> {
		if (this.isRelay) {
			const snapshot = await this.sendRpc<{ meta: SessionMeta }>("sessions.create", [cwd, modelId]);
			return { meta: snapshot.meta };
		}
		return this.request("/api/sessions", { method: "POST", body: JSON.stringify({ cwd, modelId }) });
	}

	async rpc<T = unknown>(method: string, args: unknown[] = []): Promise<{ ok: boolean; value?: T; error?: string }> {
		if (this.isRelay) {
			try {
				const val = await this.sendRpc<T>(method, args);
				return { ok: true, value: val };
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		}
		return this.request("/api/rpc", {
			method: "POST",
			body: JSON.stringify({ method, args }),
		});
	}

	async setArchived(projectId: string, sessionId: string, archived: boolean): Promise<{ ok: boolean }> {
		if (this.isRelay) {
			await this.sendRpc("sessions.setArchived", [projectId, sessionId, archived]);
			return { ok: true };
		}
		return this.request(`/api/sessions/${projectId}/${sessionId}/archived`, {
			method: "POST",
			body: JSON.stringify({ archived }),
		});
	}

	async deleteSession(projectId: string, sessionId: string): Promise<{ ok: boolean }> {
		if (this.isRelay) {
			await this.sendRpc("sessions.remove", [projectId, sessionId]);
			return { ok: true };
		}
		return this.request(`/api/sessions/${projectId}/${sessionId}`, {
			method: "DELETE",
		});
	}

	removeSession(projectId: string, sessionId: string): Promise<{ ok: boolean }> {
		return this.deleteSession(projectId, sessionId);
	}

	async scanUsage(): Promise<import("./usage").UsageScan | null> {
		const res = await this.rpc<import("./usage").UsageScan | null>("usage.scan");
		return res.ok && res.value ? res.value : null;
	}

	// -------------------------------------------------------------------------
	// Extended Remote Methods (Git, Files, Usages)
	// -------------------------------------------------------------------------

	async gitStatus(cwd: string): Promise<import("./protocol").GitStatus | null> {
		const res = await this.rpc<import("./protocol").GitStatus | null>("git.status", [cwd]);
		return res.ok && res.value ? res.value : null;
	}

	async gitStage(cwd: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
		const res = await this.rpc<{ ok: boolean; error?: string }>("git.stage", [cwd, paths]);
		return res.ok && res.value ? res.value : { ok: false, error: res.error || "stage failed" };
	}

	async gitUnstage(cwd: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
		const res = await this.rpc<{ ok: boolean; error?: string }>("git.unstage", [cwd, paths]);
		return res.ok && res.value ? res.value : { ok: false, error: res.error || "unstage failed" };
	}

	async gitCommit(cwd: string, message: string): Promise<{ ok: boolean; error?: string }> {
		const res = await this.rpc<{ ok: boolean; error?: string }>("git.commit", [cwd, message]);
		return res.ok && res.value ? res.value : { ok: false, error: res.error || "commit failed" };
	}

	async gitPush(cwd: string): Promise<{ ok: boolean; error?: string }> {
		const res = await this.rpc<{ ok: boolean; error?: string }>("git.push", [cwd]);
		return res.ok && res.value ? res.value : { ok: false, error: res.error || "push failed" };
	}

	async gitPull(cwd: string): Promise<{ ok: boolean; error?: string }> {
		const res = await this.rpc<{ ok: boolean; error?: string }>("git.pull", [cwd]);
		return res.ok && res.value ? res.value : { ok: false, error: res.error || "pull failed" };
	}

	async gitDiscard(cwd: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
		const res = await this.rpc<{ ok: boolean; error?: string }>("git.discard", [cwd, paths]);
		return res.ok && res.value ? res.value : { ok: false, error: res.error || "discard failed" };
	}

	async gitDiff(cwd: string, path: string, staged = false): Promise<string | null> {
		const res = await this.rpc<string | null>("git.diff", [cwd, path, staged]);
		return res.ok && typeof res.value === "string" ? res.value : null;
	}

	async gitLog(cwd: string, limit = 30): Promise<import("./protocol").GitCommit[]> {
		const res = await this.rpc<import("./protocol").GitCommit[]>("git.log", [cwd, limit]);
		return res.ok && Array.isArray(res.value) ? res.value : [];
	}

	async gitBranches(cwd: string): Promise<import("./protocol").BranchList | null> {
		const res = await this.rpc<import("./protocol").BranchList | null>("git.branches", [cwd]);
		return res.ok && res.value ? res.value : null;
	}

	async gitSwitch(cwd: string, branch: string): Promise<{ ok: boolean; error?: string }> {
		const res = await this.rpc<{ ok: boolean; error?: string }>("git.switch", [cwd, branch]);
		return res.ok && res.value ? res.value : { ok: false, error: res.error || "switch failed" };
	}

	async listFiles(dir: string): Promise<import("./protocol").RemoteFileEntry[]> {
		const res = await this.rpc<import("./protocol").RemoteFileEntry[]>("files.list", [dir]);
		return res.ok && Array.isArray(res.value) ? res.value : [];
	}

	async readFile(path: string): Promise<import("./protocol").RemoteFileContents | null> {
		const res = await this.rpc<import("./protocol").RemoteFileContents | null>("files.read", [path]);
		return res.ok && res.value ? res.value : null;
	}

	// -------------------------------------------------------------------------
	// WebSocket Connection & Relay Multi-plexing
	// -------------------------------------------------------------------------

	onEvent(listener: (sessionId: string, event: AgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onStateChange(listener: (state: "connecting" | "open" | "closed") => void): () => void {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}

	private lastCloseError: string | null = null;

	connect(): void {
		if (this.socket) return;
		this.closedByUser = false;
		this.lastCloseError = null;
		this.emitState("connecting");

		let wsUrl: string;
		if (this.isRelay) {
			const cleanHost = this.connection.host.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/:\d+$/, "").trim();
			const proto = this.connection.secure === false ? "ws" : "wss";
			const portSuffix = (proto === "wss" && this.connection.port === 443) || (proto === "ws" && this.connection.port === 80)
				? ""
				: `:${this.connection.port}`;
			wsUrl = `${proto}://${cleanHost}${portSuffix}`;
		} else {
			const cleanHost = this.connection.host.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/:\d+$/, "").trim();
			const wsProto = this.isHttps ? "wss" : "ws";
			wsUrl = `${wsProto}://${cleanHost}:${this.connection.port}/ws?token=${encodeURIComponent(this.connection.token)}`;
		}

		const socket = new WebSocket(wsUrl);
		this.socket = socket;

		socket.onopen = () => {
			if (this.isRelay) {
				// Announce zero-knowledge room to relay server
				const room = sha256(this.connection.token);
				socket.send(JSON.stringify({ type: "hello", room, role: "guest" }));
				// Relay will reply { type: "waiting" } or { type: "ready" }
			} else {
				this.emitState("open");
			}
		};

		socket.onmessage = (event) => {
			let payload: Record<string, unknown>;
			try {
				payload = JSON.parse(String(event.data)) as Record<string, unknown>;
			} catch {
				return;
			}

			// 1. Relay status frames
			if (this.isRelay) {
				if (payload.type === "error") {
					const reason = String(payload.reason || "未知原因");
					if (reason === "kicked") {
						this.lastCloseError = "已在其他设备连接，当前连接已断开";
						this.closedByUser = true; // Stop auto-reconnecting loop if kicked
					} else {
						this.lastCloseError = `中继服务拒绝: ${reason}`;
					}
					this.emitState("closed");
					return;
				}
				if (payload.type === "peer-left") {
					// Far-end disconnected from relay; revert to waiting state
					this.emitState("connecting");
					return;
				}
				if (payload.type === "waiting") {
					// In room alone, waiting for desktop side
					this.emitState("connecting");
					return;
				}
				if (payload.type === "ready") {
					// Desktop side is connected in room, tunnel ready
					this.emitState("open");
					// Send a ping to desktop through tunnel to trigger immediate handshake
					this.socket?.send(JSON.stringify({ type: "hello", version: 1 }));
					return;
				}
				if (payload.type === "hello" && typeof payload.version === "number") {
					// Handshake received from desktop sync server through relay tunnel
					this.emitState("open");
					return;
				}
			}

			// 2. RPC response frames
			if (payload.type === "rpc_result" && typeof payload.id === "string") {
				const pending = this.pendingRpcs.get(payload.id);
				if (pending) {
					this.pendingRpcs.delete(payload.id);
					clearTimeout(pending.timer);
					if (payload.ok === false) {
						pending.reject(new Error(String(payload.error || "RPC error")));
					} else {
						// Result may be payload.value or top-level properties
						pending.resolve(payload.value !== undefined ? payload.value : payload);
					}
				}
				return;
			}

			// 3. Agent Event frames
			if (payload.type === "agent_event" && typeof payload.sessionId === "string" && payload.event) {
				for (const listener of this.listeners) {
					listener(payload.sessionId, payload.event as AgentEvent);
				}
				return;
			}
		};

		socket.onclose = (event) => {
			this.socket = null;
			if (!this.lastCloseError) {
				const detail = event.reason ? ` (${event.reason})` : event.code ? ` (code: ${event.code})` : "";
				this.lastCloseError = `连接断开${detail}`;
			}
			this.emitState("closed");

			// Reject any pending in-flight RPCs
			for (const [, pending] of this.pendingRpcs) {
				clearTimeout(pending.timer);
				pending.reject(new Error("WebSocket closed"));
			}
			this.pendingRpcs.clear();

			if (!this.closedByUser) this.scheduleReconnect();
		};

		socket.onerror = () => socket.close();
	}

	disconnect(): void {
		this.closedByUser = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		this.socket?.close();
		this.socket = null;

		for (const [, pending] of this.pendingRpcs) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Client disconnected"));
		}
		this.pendingRpcs.clear();
	}

	reconnectNow(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.socket && this.socket.readyState === WebSocket.OPEN) {
			return;
		}
		if (this.socket) {
			try {
				this.socket.close();
			} catch {
				// ignore
			}
			this.socket = null;
		}
		this.connect();
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, 3000);
	}

	private currentState: "connecting" | "open" | "closed" = "closed";

	private emitState(state: "connecting" | "open" | "closed"): void {
		this.currentState = state;
		for (const listener of this.stateListeners) listener(state);
	}
}
