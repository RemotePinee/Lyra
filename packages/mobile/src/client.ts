/**
 * Client for the desktop sync server.
 *
 * Two channels: HTTP for commands and history, a WebSocket for live agent events. The
 * WebSocket is best-effort — on reconnect the client re-reads the session log from the last
 * sequence number it saw, so a dropped connection never loses a turn.
 */

import type { AgentEvent, RemoteSettings, SessionMeta, SessionRecord, UserContent } from "./protocol";

export interface Connection {
	host: string;
	port: number;
	token: string;
	secure?: boolean;
}

export class SyncClient {
	private connection: Connection;
	private socket: WebSocket | null = null;
	private listeners = new Set<(sessionId: string, event: AgentEvent) => void>();
	private stateListeners = new Set<(state: "connecting" | "open" | "closed") => void>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private closedByUser = false;

	constructor(connection: Connection) {
		this.connection = connection;
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
	// HTTP
	// -------------------------------------------------------------------------

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
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

	static async ping(host: string, port: number): Promise<{ ok: boolean; reason?: string; secure?: boolean }> {
		const cleanHost = host.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/:\d+$/, "").trim();
		const isExplicitHttps = /^https:\/\//i.test(host);

		// Helper to probe a specific protocol
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

		// If user explicitly provided https or domain name, probe https first
		if (isExplicitHttps) {
			return probe("https");
		}

		// Try http first, if failed then auto probe https
		const httpRes = await probe("http");
		if (httpRes.ok) return httpRes;

		const httpsRes = await probe("https");
		if (httpsRes.ok) return httpsRes;

		return httpRes.reason ? httpRes : httpsRes;
	}

	async verify(): Promise<boolean> {
		try {
			await this.listSessions();
			return true;
		} catch {
			return false;
		}
	}

	listSessions(): Promise<{ sessions: SessionMeta[] }> {
		return this.request("/api/sessions");
	}

	settings(): Promise<RemoteSettings> {
		return this.request("/api/settings");
	}

	records(
		projectId: string,
		sessionId: string,
		options?: { since?: number; before?: number; limit?: number; tail?: number },
	): Promise<{ records: SessionRecord[]; total?: number; hasEarlier?: boolean }> {
		const params = new URLSearchParams();
		if (typeof options?.since === "number") params.set("since", String(options.since));
		if (typeof options?.before === "number") params.set("before", String(options.before));
		if (typeof options?.limit === "number") params.set("limit", String(options.limit));
		if (typeof options?.tail === "number") params.set("tail", String(options.tail));
		const qs = params.toString();
		return this.request(`/api/sessions/${projectId}/${sessionId}${qs ? `?${qs}` : ""}`);
	}

	status(projectId: string, sessionId: string): Promise<{
		meta: SessionMeta;
		running: boolean;
		pendingApprovals: { id: string; request: { kind: string; title: string; detail: string } }[];
	}> {
		return this.request(`/api/sessions/${projectId}/${sessionId}/status`);
	}

	prompt(projectId: string, sessionId: string, content: UserContent[]): Promise<{ accepted: boolean }> {
		return this.request(`/api/sessions/${projectId}/${sessionId}/prompt`, {
			method: "POST",
			body: JSON.stringify({ content }),
		});
	}

	abort(projectId: string, sessionId: string): Promise<{ aborted: boolean }> {
		return this.request(`/api/sessions/${projectId}/${sessionId}/abort`, { method: "POST" });
	}

	approve(
		projectId: string,
		sessionId: string,
		requestId: string,
		decision: "once" | "always" | "reject",
	): Promise<{ resolved: boolean }> {
		return this.request(`/api/sessions/${projectId}/${sessionId}/approve`, {
			method: "POST",
			body: JSON.stringify({ requestId, decision }),
		});
	}

	setModel(projectId: string, sessionId: string, modelId: string): Promise<{ ok: boolean }> {
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

	rename(projectId: string, sessionId: string, title: string): Promise<{ ok: boolean; meta: SessionMeta }> {
		return this.request(`/api/sessions/${projectId}/${sessionId}/rename`, {
			method: "POST",
			body: JSON.stringify({ title }),
		});
	}

	createSession(cwd: string, modelId?: string): Promise<{ meta: SessionMeta }> {
		return this.request("/api/sessions", { method: "POST", body: JSON.stringify({ cwd, modelId }) });
	}

	rpc<T = unknown>(method: string, args: unknown[] = []): Promise<{ ok: boolean; value?: T; error?: string }> {
		return this.request("/api/rpc", {
			method: "POST",
			body: JSON.stringify({ method, args }),
		});
	}

	setArchived(projectId: string, sessionId: string, archived: boolean): Promise<{ ok: boolean }> {
		return this.rpc("sessions.setArchived", [projectId, sessionId, archived]);
	}

	removeSession(projectId: string, sessionId: string): Promise<{ ok: boolean }> {
		return this.rpc("sessions.remove", [projectId, sessionId]);
	}

	async scanUsage(): Promise<import("./usage").UsageScan | null> {
		const res = await this.rpc<import("./usage").UsageScan | null>("usage.scan", []);
		return res.ok && res.value ? res.value : null;
	}

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
	// WebSocket
	// -------------------------------------------------------------------------

	onEvent(listener: (sessionId: string, event: AgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onStateChange(listener: (state: "connecting" | "open" | "closed") => void): () => void {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}

	connect(): void {
		if (this.socket) return;
		this.closedByUser = false;
		this.emitState("connecting");

		const cleanHost = this.connection.host.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/:\d+$/, "").trim();
		const wsProto = this.isHttps ? "wss" : "ws";
		const socket = new WebSocket(
			`${wsProto}://${cleanHost}:${this.connection.port}/ws?token=${encodeURIComponent(this.connection.token)}`,
		);
		this.socket = socket;

		socket.onopen = () => this.emitState("open");

		socket.onmessage = (event) => {
			let payload: { type?: string; sessionId?: string; event?: AgentEvent };
			try {
				payload = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (payload.type !== "agent_event" || !payload.sessionId || !payload.event) return;
			for (const listener of this.listeners) listener(payload.sessionId, payload.event);
		};

		socket.onclose = () => {
			this.socket = null;
			this.emitState("closed");
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
	}

	/** Immediate reconnect trigger without waiting for the 3s backoff timer, used on app foreground resume */
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

	private emitState(state: "connecting" | "open" | "closed"): void {
		for (const listener of this.stateListeners) listener(state);
	}
}
