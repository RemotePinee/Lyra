import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { spawn as spawnPty, type IPty } from "node-pty";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, screen, session, shell } from "electron";
import {
	AgentSession,
	buildIndex,
	createContext,
	deepwiseHome,
	previewsHome,
	pruneSessionArtifacts,
	useAgentLoop,
	useCompaction,
	useLlmRegistry,
	useSandbox,
	useScheduler,
	useSkillRegistry,
	useToolRegistry,
	useTurnPipeline,
	COMPACTION,
	LLM,
	LOOP,
	SANDBOX,
	SCHEDULER,
	SESSION,
	SKILLS,
	STORAGE,
	TOOLS,
	removeSessionArtifacts,
	indexStats,
	loadIndex,
	loadSettings,
	saveIndex,
	saveSettings,
	searchIndex,
	SessionStore,
	SideChat,
	type AgentEvent,
	type ApprovalDecision,
	type AgentLoop,
	type CompactionStrategy,
	type Context as CapabilityContext,
	type ContextBreakdown,
	type LlmRegistry,
	type Sandbox,
	type Settings,
	type SessionStorage,
	type SkillRegistry,
	type TaskScheduler,
	type TurnPipeline,
	type ToolRegistry,
	type UserContent,
} from "@deepwise/core";
import type {
	AgentCapabilities,
	FileContents,
	FileEntry,
	ProviderTestResult,
	SessionSnapshot,
	SyncStatus,
	WorkspaceInfo,
} from "./ipc-types.ts";
import { createBrowserTools } from "./browser-tools.ts";
import {
	collectWorkspaceDiff,
	gitBranch,
	isGitRepo,
} from "./git.ts";
import { appIcon } from "./app-icon.ts";
import {
	broadcast,
	broadcastSideChat,
	browsers,
	configureHub,
	getOrCreateSession,
	MAX_LIVE_SESSIONS,
	sessions,
	snapshot,
	touchSession,
} from "./session-hub.ts";
import { registerFilesIpc } from "./ipc/files.ts";
import { registerSessionsIpc } from "./ipc/sessions.ts";
import { ensureLiveSession } from "./session-hub.ts";
import {
	applyNativeAppearance,
	createWindow,
	getWindow,
	resolvedBackground,
	useSettingsSource,
	writeWindowState,
} from "./window.ts";
import { MEDIA_SCHEME, PREVIEW_SCHEME, registerPreviewProtocols } from "./preview-protocol.ts";
import { registerGitIpc } from "./ipc/git.ts";
import { registerSideChatIpc } from "./ipc/side-chat.ts";
import { registerPluginsIpc } from "./ipc/plugins.ts";
import { registerSystemIpc } from "./ipc/system.ts";
import { registerTerminalIpc } from "./ipc/terminal.ts";
import { Scheduler } from "./scheduler.ts";
import { SyncServer } from "./sync-server.ts";

const execFileAsync = promisify(execFile);

/** Private scheme the renderer uses to preview images and video from the open project. */

/**
 * Previews get a scheme of their own, and deliberately not `file://`.
 *
 * A page the agent wrote is untrusted code. Served from its own origin it is subject to the
 * normal same-origin rules, cannot read the user's disk by walking `file:///`, and can be
 * pinned to a directory by the handler below — none of which is true of a file URL.
 */

/** Shared with the renderer's `<webview partition>`; they must name the same partition. */
const BROWSER_PARTITION = "persist:dw-browser";

/**
 * Whether a path is inside a project the user has opened.
 *
 * The file panel exists to look at what you are working on. Without this check the renderer
 * could ask for any path on the disk, which is a materially different capability from the one
 * the panel advertises — and one the agent's own file tools gate behind approvals.
 *
 * Module scope because both the IPC handlers and the media protocol need it, and they must
 * agree: a boundary enforced in one of two doorways is not a boundary.
 *
 * Compared with a trailing separator so `/work/app-secrets` cannot pass as `/work/app`.
 */
function insideAProject(target: string): boolean {
	return (settings?.projects ?? []).some(
		(project) => target === project.path || target.startsWith(project.path + sep),
	);
}

/*
 * Resolved from the kernel once it is up.
 *
 * Declared here because everything in this file reaches for it, and assigned at boot so that a
 * plugin providing a different store is actually the one used.
 */
let store: SessionStorage = new SessionStore();
/** Live sessions keyed by session id. A session stays warm so MCP servers are not respawned per turn. */

/** The capability context: what the app can do, assembled from plugins at boot. */
let kernel: CapabilityContext | null = null;
/** Per-session browser instances, disposed alongside the session that owns them. */
/**
 * Side chats, keyed by the session each one is attached to.
 *
 * Memory only. They hold a live `AgentSession` reference, so one cannot outlive the session
 * it reads — disposing a session drops its side chat with it.
 */
const sideChats = new Map<string, SideChat>();
/** Live pseudo-terminals, one per terminal tab. Killed when the app quits. */
const terminals = new Map<string, IPty>();
let settings: Settings;

let syncServer: SyncServer | null = null;
/**
 * Whether the window is currently showing a vibrant material.
 *
 * Tracked because two handlers write the same property. `window:theme` repaints the backing
 * colour so a fast resize does not flash the old palette — but under vibrancy that colour is
 * exactly what must stay transparent, and an opaque one painted over the material is the
 * material gone. Whichever message arrived last used to win.
 */
let vibrant = process.platform === "darwin";
let scheduler: Scheduler | null = null;

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

protocol.registerSchemesAsPrivileged([
	{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true } },
	{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

app.whenReady().then(async () => {
	await mkdir(deepwiseHome(), { recursive: true });

	/*
	 * Capabilities first, everything else after.
	 *
	 * The model adapters, the tool set and the approval policy are contributed by plugins into a
	 * context, and the kernel is pointed at that context here — before any session exists. Nothing
	 * downstream imports a concrete implementation, so replacing one (a sandboxed shell, another
	 * model API, a stricter policy) is a change to this list rather than to the code that uses it.
	 */
	kernel = await createContext();
	useLlmRegistry(kernel.require<LlmRegistry>(LLM));
	useToolRegistry(kernel.require<ToolRegistry>(TOOLS));
	useSandbox(kernel.require<Sandbox>(SANDBOX));
	store = kernel.require<SessionStorage>(STORAGE);
	useCompaction(kernel.require<CompactionStrategy>(COMPACTION));
	useSkillRegistry(kernel.require<SkillRegistry>(SKILLS));
	useScheduler(kernel.require<TaskScheduler>(SCHEDULER));
	useAgentLoop(kernel.require<AgentLoop>(LOOP));
	useTurnPipeline(kernel.require<TurnPipeline>(SESSION).all());

	settings = await loadSettings();
	useSettingsSource(() => settings);
	configureHub({ store: () => store, settings: () => settings, window: getWindow, sync: () => syncServer });
	// Before the window exists, so its very first frame gets the right material.
	applyNativeAppearance();

	registerPreviewProtocols({ browserPartition: BROWSER_PARTITION, insideAProject });

	// Clear out sessions that were reserved and never used — including any left over from
	// when clicking "新对话" created one up front.
	const pruned = await store.pruneEmpty().catch(() => 0);
	if (pruned > 0) console.log(`[deepwise] 清理了 ${pruned} 个空会话`);

	/*
	 * Previews outlive nothing. Anything belonging to a conversation that is gone goes with it,
	 * and what remains expires on its own after a month — otherwise every sketch ever rendered
	 * would sit in the app directory forever, since nothing else would ever think to remove it.
	 */
	void store
		.listSessions()
		.then((all) => pruneSessionArtifacts(deepwiseHome(), new Set(all.map((s) => s.id))))
		.then((gone) => {
			if (gone > 0) console.log(`[deepwise] 清理了 ${gone} 个会话的临时文件`);
		})
		.catch(() => {});
	registerIpc();
	createWindow();
	if (settings.sync.enabled) await startSync();

	scheduler = new Scheduler({
		getSettings: () => settings,
		saveSettings: async (next) => {
			settings = next;
			await saveSettings(next);
			getWindow()?.webContents.send("settings:changed", next);
		},
		createSession: (cwd, modelId) => getOrCreateSession(cwd, modelId),
		notify: (message, level) => getWindow()?.webContents.send("scheduler:notice", { message, level }),
	});
	scheduler.start();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
	scheduler?.stop();
	for (const dispose of browsers.values()) dispose();
	browsers.clear();
	// Shells are real child processes; without this they outlive the window that opened them.
	for (const terminal of terminals.values()) terminal.kill();
	terminals.clear();
	await Promise.all([...sessions.values()].map((s) => s.dispose()));
	await syncServer?.stop();
	// Unwinds every capability the plugins installed, in the reverse of the order they arrived.
	useLlmRegistry(null);
	useToolRegistry(null);
	useSandbox(null);
	useCompaction(null);
	useSkillRegistry(null);
	useScheduler(null);
	useAgentLoop(null);
	useTurnPipeline(null);
	await kernel?.dispose();
	kernel = null;
});

async function startSync(): Promise<SyncStatus> {
	if (!syncServer) {
		syncServer = new SyncServer({
			getSettings: () => settings,
			saveSettings: async (next) => {
				settings = next;
				await saveSettings(next);
				getWindow()?.webContents.send("settings:changed", next);
			},
			store,
			resolveSession: async (projectId, sessionId) => {
				const existing = sessions.get(sessionId);
				if (existing) return existing;
				const loaded = await store.load(projectId, sessionId);
				if (!loaded) return null;
				const session = new AgentSession({
					cwd: loaded.meta.cwd,
					settings,
					store,
					meta: loaded.meta,
					emit: (event) => broadcast(sessionId, event),
				});
				session.messages = loaded.messages;
				await session.initialize();
				sessions.set(sessionId, session);
				return session;
			},
			createSession: (cwd, modelId) => getOrCreateSession(cwd, modelId),
		});
	}
	return syncServer.start(settings.sync.port, settings.sync.token);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void {
	ipcMain.handle("settings:get", async () => settings);

	ipcMain.handle("settings:save", async (_event, next: Settings) => {
		settings = next;
		// Before anything else: the window's appearance is part of what was just changed.
		applyNativeAppearance();
		await saveSettings(next);
		for (const session of sessions.values()) session.updateSettings(next);
		for (const chat of sideChats.values()) chat.updateSettings(next);
		if (next.sync.enabled && !syncServer?.running) await startSync();
		else if (!next.sync.enabled && syncServer?.running) await syncServer.stop();
		return settings;
	});

	ipcMain.handle("workspace:pick", async (): Promise<WorkspaceInfo | null> => {
		const window = getWindow();
		if (!window) return null;
		const result = await dialog.showOpenDialog(window, {
			properties: ["openDirectory", "createDirectory"],
			title: "选择项目目录",
		});
		if (result.canceled || result.filePaths.length === 0) return null;
		return workspaceInfo(result.filePaths[0]);
	});

	ipcMain.handle("workspace:info", async (_event, path: string) => workspaceInfo(path));

	/**
	 * Repaint the system window controls to match the theme.
	 *
	 * Only Windows and Linux have this strip — macOS keeps its own lights outside the page —
	 * and Electron throws if the window was not created with an overlay, so the call is guarded
	 * rather than merely no-op'd.
	 */
	/*
	 * Toggled without recreating the window.
	 *
	 * `vibrancy` is a constructor option but also a live setter, so flipping the switch takes
	 * effect immediately. The backing colour has to move with it: an opaque one would sit over
	 * the vibrant layer and hide the very thing it was turned on for.
	 */
	ipcMain.on("window:vibrancy", (_event, on: boolean) => {
		const window = getWindow();
		if (process.platform !== "darwin" || !window) return;
		vibrant = on;
		window.setVibrancy(on ? "sidebar" : null);
		window.setBackgroundColor(on ? "#00000000" : resolvedBackground());
	});

	ipcMain.on("window:theme", (_event, colors: { color: string; symbolColor: string }) => {
		const window = getWindow();
		if (!window || window.isDestroyed()) return;
		/*
		 * Repaint the window's own backing colour, not just the OS-drawn controls.
		 *
		 * This is the surface a fast resize exposes before the renderer has reflowed, so it has
		 * to track the theme — otherwise dragging an edge flashes the old palette's background.
		 */
		if (!vibrant) window.setBackgroundColor(colors.color);
		if (process.platform === "darwin") return;
		try {
			window.setTitleBarOverlay({ ...colors, height: 44 });
		} catch {}
	});


	ipcMain.handle("workspace:reveal", async (_event, path: string) => {
		shell.showItemInFolder(path);
	});

	registerSessionsIpc({
		store: () => store,
		settings: () => settings,
		saveSettings: async (next) => {
			settings = next;
			await saveSettings(next);
		},
	});

	registerSideChatIpc({ sideChats, sessions, settings: () => settings, ensureSession: (id: string) => ensureLiveSession(id), broadcastSideChat });

	registerFilesIpc({ insideAProject });

	registerTerminalIpc({ terminals, spawnPty, insideAProject, window: () => getWindow() });

	ipcMain.handle("providers:test", async (_event, providerId: string): Promise<ProviderTestResult> => {
		const provider = settings.providers.find((p) => p.id === providerId);
		if (!provider) return { ok: false, latencyMs: 0, message: "未找到该供应商配置" };
		return testProvider(provider);
	});

	ipcMain.handle("sync:status", async () => syncServer?.status() ?? idleSyncStatus());
	ipcMain.handle("sync:start", async () => {
		settings = { ...settings, sync: { ...settings.sync, enabled: true } };
		await saveSettings(settings);
		return startSync();
	});
	ipcMain.handle("sync:stop", async () => {
		settings = { ...settings, sync: { ...settings.sync, enabled: false } };
		await saveSettings(settings);
		await syncServer?.stop();
		return syncServer?.status() ?? idleSyncStatus();
	});
	ipcMain.handle("sync:rotateToken", async () => {
		const token = crypto.randomUUID().replace(/-/g, "");
		settings = { ...settings, sync: { ...settings.sync, token } };
		await saveSettings(settings);
		await syncServer?.stop();
		return startSync();
	});

	// Scanning does not need a live session: the settings pages are usually opened before
	// any conversation exists, and an empty plugin list there reads as "nothing installed".
	registerPluginsIpc({ disabledPlugins: () => settings.disabledPlugins });

	registerSystemIpc();

	ipcMain.handle("index:stats", async (_event, cwd: string) => indexStats(cwd));

	ipcMain.handle("index:rebuild", async (_event, cwd: string) => {
		const index = await buildIndex(cwd);
		await saveIndex(index);
		// Live sessions hold a cached copy; drop it so the next lookup sees the rebuild.
		for (const session of sessions.values()) {
			if (session.cwd === cwd) session.invalidateSymbolIndex();
		}
		return indexStats(cwd);
	});

	ipcMain.handle("index:search", async (_event, cwd: string, query: string) => {
		const index = (await loadIndex(cwd)) ?? (await buildIndex(cwd));
		return searchIndex(index, query, undefined, 50).map((s) => ({
			name: s.name,
			kind: s.kind,
			file: s.file,
			line: s.line,
		}));
	});

	ipcMain.handle("scheduler:runNow", async (_event, taskId: string) => {
		const task = settings.scheduledTasks.find((t) => t.id === taskId);
		if (!task) return { ok: false, error: "任务不存在" };
		// Clearing lastRunAt makes the task due, then one tick runs it through the normal path.
		settings = {
			...settings,
			scheduledTasks: settings.scheduledTasks.map((t) => (t.id === taskId ? { ...t, lastRunAt: undefined } : t)),
		};
		await scheduler?.tick();
		return { ok: true };
	});

	registerGitIpc({ insideAProject });
}

async function workspaceInfo(path: string): Promise<WorkspaceInfo | null> {
	if (!existsSync(path)) return null;
	const git = await isGitRepo(path);
	const diff = git ? await collectWorkspaceDiff(path) : { added: 0, removed: 0, branch: null, files: [] };
	return {
		path,
		name: path.split("/").filter(Boolean).pop() ?? path,
		isGitRepo: git,
		branch: git ? await gitBranch(path) : null,
		added: diff.added,
		removed: diff.removed,
	};
}

function idleSyncStatus(): SyncStatus {
	return { running: false, port: settings?.sync.port ?? 4517, token: settings?.sync.token ?? null, addresses: [], clients: 0, pairingUrl: null };
}

/**
 * Probe a provider with a one-token request. A models listing is attempted first because it
 * is free, but many relays do not expose one, so a failure there is not treated as fatal.
 */
async function testProvider(provider: Settings["providers"][number]): Promise<ProviderTestResult> {
	const started = Date.now();
	const base = provider.baseUrl.replace(/\/+$/, "");
	const modelsUrl = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;

	let models: string[] | undefined;
	try {
		const listed = await fetch(modelsUrl, {
			headers:
				provider.api === "anthropic-messages"
					? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" }
					: { authorization: `Bearer ${provider.apiKey}` },
			signal: AbortSignal.timeout(15_000),
		});
		if (listed.ok) {
			const body = (await listed.json()) as { data?: { id?: string }[] };
			models = body.data?.map((m) => m.id ?? "").filter(Boolean).slice(0, 200);
		}
	} catch {
		models = undefined;
	}

	const model = provider.models[0];
	if (!model) {
		return models
			? { ok: true, latencyMs: Date.now() - started, message: `连接成功，发现 ${models.length} 个可用模型`, models }
			: { ok: false, latencyMs: Date.now() - started, message: "请先添加至少一个模型再测试" };
	}

	try {
		const isAnthropic = provider.api === "anthropic-messages";
		const response = await fetch(isAnthropic ? `${base}/v1/messages`.replace("/v1/v1/", "/v1/") : `${base}/v1/responses`.replace("/v1/v1/", "/v1/"), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(isAnthropic
					? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" }
					: { authorization: `Bearer ${provider.apiKey}` }),
			},
			body: JSON.stringify(
				isAnthropic
					? { model: model.modelId, max_tokens: 8, messages: [{ role: "user", content: "hi" }] }
					: { model: model.modelId, input: "hi", max_output_tokens: 16, stream: false, store: false },
			),
			signal: AbortSignal.timeout(30_000),
		});
		const latencyMs = Date.now() - started;
		if (!response.ok) {
			const detail = (await response.text().catch(() => "")).slice(0, 300);
			return { ok: false, latencyMs, message: `HTTP ${response.status}: ${detail}`, models };
		}
		return { ok: true, latencyMs, message: `连接成功，${model.name} 响应正常`, models };
	} catch (error) {
		return {
			ok: false,
			latencyMs: Date.now() - started,
			message: error instanceof Error ? error.message : String(error),
			models,
		};
	}
}
