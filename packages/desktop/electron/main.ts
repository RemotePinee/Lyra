import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn as spawnPty, type IPty } from "node-pty";
import { app, BrowserWindow, protocol } from "electron";
import {
	createContext,
	lyraHome,
	migratePreviousHome,
	loadCapabilityPlugins,
	loadPlugins,
	DEFAULT_PLUGINS,
	pruneSessionArtifacts,
	WINDOWS_RUNNER_FLAG,
	runSandboxRunner,
	registerSearchProvider,
	duckDuckGoProvider,
	instantAnswerProvider,
	keyedSearchProvider,
	BRAVE_PROVIDER_ID,
	EXA_PROVIDER_ID,
	TAVILY_PROVIDER_ID,
	useAgentLoop,
	useApprovalPolicy,
	useCompaction,
	useLlmRegistry,
	useSandbox,
	useScheduler,
	useSkillRegistry,
	useToolRegistry,
	useTurnPipeline,
	APPROVAL,
	COMPACTION,
	LLM,
	LOOP,
	SANDBOX,
	SCHEDULER,
	SESSION,
	SKILLS,
	STORAGE,
	TOOLS,
	SessionStore,
	SideChat,
	type AgentLoop,
	type ApprovalPolicy,
	type CompactionStrategy,
	type Context as CapabilityContext,
	type LlmRegistry,
	type Sandbox,
	type Settings,
	type SessionStorage,
	type SkillRegistry,
	type TaskScheduler,
	type TurnPipeline,
	type ToolRegistry,
} from "@lyra/core";
import {
	broadcastSideChat,
	browsers,
	configureHub,
	getOrCreateSession,
	sessions,
} from "./session-hub.ts";
import { resolveInside } from "./file-ops.ts";
import { registerFilesIpc } from "./ipc/files.ts";
import { registerFileOpsIpc } from "./ipc/file-ops.ts";
import { rescueLegacyWorkspaces } from "./scratch.ts";
import { applySettings, loadAppSettings, onSettingsChanged } from "./app-settings.ts";
import { registerServicesIpc } from "./ipc/services.ts";
import { registerWorkspaceIpc } from "./ipc/workspace.ts";
import { workspaceInfo } from "./workspace-info.ts";
import { configureSync, startSync, stopSync, syncStatusSource } from "./sync.ts";
import { idleSyncStatus, testProvider } from "./providers.ts";
import { registerSessionsIpc } from "./ipc/sessions.ts";
import { ensureLiveSession } from "./session-hub.ts";
import {
	appIconPath,
	applyNativeAppearance,
	createWindow,
	getWindow,
	registerWindowIpc,
	useSettingsSource,
} from "./window.ts";
import { MEDIA_SCHEME, PREVIEW_SCHEME, registerPreviewProtocols } from "./preview-protocol.ts";
import { registerGitIpc } from "./ipc/git.ts";
import { registerSideChatIpc } from "./ipc/side-chat.ts";
import { registerUpdateIpc } from "./ipc/updates.ts";
import { registerTerminalIpc } from "./ipc/terminal.ts";
import { Scheduler } from "./scheduler.ts";
import { createTray, destroyTray, hasTray, type TrayCommand } from "./tray.ts";



/** Private scheme the renderer uses to preview images and video from the open project. */

/**
 * Previews get a scheme of their own, and deliberately not `file://`.
 *
 * A page the agent wrote is untrusted code. Served from its own origin it is subject to the
 * normal same-origin rules, cannot read the user's disk by walking `file:///`, and can be
 * pinned to a directory by the handler below — none of which is true of a file URL.
 */

/** Shared with the renderer's `<webview partition>`; they must name the same partition. */
const BROWSER_PARTITION = "persist:ly-browser";

/**
 * A path inside a project the user has opened, normalised — or null.
 *
 * The file panel exists to look at what you are working on. Without this check the renderer
 * could ask for any path on the disk, which is a materially different capability from the one
 * the panel advertises — and one the agent's own file tools gate behind approvals.
 *
 * Module scope because the IPC handlers and the media protocol both need it, and they must
 * agree: a boundary enforced in one of two doorways is not a boundary.
 *
 * `resolveInside` returns the resolved path so callers do their IO against the string that was
 * actually checked — see the note there on why comparing the raw one let `..` walk out.
 */
function projectPath(target: string): string | null {
	return resolveInside(
		target,
		(settings?.projects ?? []).map((project) => project.path),
	);
}

/** The predicate form, for the doorways that only need a yes or no. */
function insideAProject(target: string): boolean {
	return projectPath(target) !== null;
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

/**
 * Whether the window is currently showing a vibrant material.
 *
 * Tracked because two handlers write the same property. `window:theme` repaints the backing
 * colour so a fast resize does not flash the old palette — but under vibrancy that colour is
 * exactly what must stay transparent, and an opaque one painted over the material is the
 * material gone. Whichever message arrived last used to win.
 */

let scheduler: Scheduler | null = null;

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

protocol.registerSchemesAsPrivileged([
	{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true } },
	{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

/*
 * The name, before anything can ask for it.
 *
 * Packaged, this comes from the bundle. Run from source it does not exist, so macOS falls back to
 * the binary's name — and the dock, the menu bar and the "force quit" list all say Electron. It
 * also decides where `app.getPath("userData")` points, which is why it is set here rather than
 * after the app is ready.
 */
/*
 * The one thing that has to happen before anything else.
 *
 * On Windows a confined command is run by spawning this same executable with a marker flag; that
 * process must do the Win32 work and exit, never become a second copy of the app. Checked here
 * because "before the app is ready" is not early enough — module side effects would already have
 * run by then.
 */
if (process.argv.includes(WINDOWS_RUNNER_FLAG)) {
	const start = process.argv.indexOf(WINDOWS_RUNNER_FLAG) + 1;
	process.exit(runSandboxRunner(process.argv.slice(start)));
}

app.setName("Lyra");

app.whenReady().then(async () => {
	/*
	 * Before anything reads or writes it: the home directory was called `.deepwise` until the app
	 * was renamed, and to someone who had been using it, a fresh empty one is indistinguishable
	 * from having lost every session.
	 */
	const migration = await migratePreviousHome(lyraHome());
	if (migration.moved) console.log(`[lyra] 已把 ${migration.from} 迁移到 ${migration.to}`);
	if (migration.error) console.warn(`[lyra] 旧目录迁移失败：${migration.error}`);

	await mkdir(lyraHome(), { recursive: true });

	/*
	 * Before the sweep below gets to them.
	 *
	 * Project-less conversations used to run in `scratch/`, which is also where `core` puts the
	 * throwaway files it names after a session and deletes when that session is gone. `general` and
	 * `owner-repo-6381` were never session ids, so every launch deleted the working directory of
	 * every such conversation. They live in `workspaces/` now; this carries over whatever the last
	 * launch had not yet destroyed, and has to run first for that to mean anything.
	 */
	const rescued = await rescueLegacyWorkspaces().catch(() => []);
	if (rescued.length > 0) console.log(`[lyra] 把 ${rescued.length} 个无项目会话的目录挪到了 workspaces/：${rescued.join("、")}`);

	/*
	 * The dock icon, which macOS otherwise takes from the bundle.
	 *
	 * In development there is no bundle, so it shows Electron's own logo — on the dock, in the
	 * app switcher and in the "force quit" list. Setting it here is the only way to be looking at
	 * this application rather than at Electron while developing it.
	 */
	if (process.platform === "darwin") {
		const icon = appIconPath();
		if (icon) app.dock?.setIcon(icon);
	}

	/*
	 * Capabilities first, everything else after.
	 *
	 * The model adapters, the tool set and the approval policy are contributed by plugins into a
	 * context, and the kernel is pointed at that context here — before any session exists. Nothing
	 * downstream imports a concrete implementation, so replacing one (a sandboxed shell, another
	 * model API, a stricter policy) is a change to this list rather than to the code that uses it.
	 */
	/*
	 * The kernel is built from the default set plus whatever the user has installed.
	 *
	 * Discovering plugins before the window exists is deliberate: a plugin that replaces the model
	 * registry or the sandbox has to be in place before the first session is built, not bolted on
	 * afterwards. A bundle that fails to load is recorded and skipped — someone else's broken
	 * plugin must not be why the app will not start.
	 */
	settings = await loadAppSettings();
	const bundles = await loadPlugins(
		[{ dir: join(lyraHome(), "plugins"), source: "user" as const }],
		settings.disabledPlugins,
	);
	const extra = await loadCapabilityPlugins(bundles.plugins);
	for (const diagnostic of extra.diagnostics) console.warn(`[plugin] ${diagnostic.path}: ${diagnostic.message}`);
	kernel = await createContext([...DEFAULT_PLUGINS, ...extra.plugins]);
	useLlmRegistry(kernel.require<LlmRegistry>(LLM));
	useToolRegistry(kernel.require<ToolRegistry>(TOOLS));
	useSandbox(kernel.require<Sandbox>(SANDBOX));
	store = kernel.require<SessionStorage>(STORAGE);
	useCompaction(kernel.require<CompactionStrategy>(COMPACTION));
	useApprovalPolicy(kernel.require<ApprovalPolicy>(APPROVAL));
	useSkillRegistry(kernel.require<SkillRegistry>(SKILLS));
	useScheduler(kernel.require<TaskScheduler>(SCHEDULER));
	useAgentLoop(kernel.require<AgentLoop>(LOOP));
	useTurnPipeline(kernel.require<TurnPipeline>(SESSION).all());

	/*
	 * What a settings change has to reach.
	 *
	 * Registered once, here, rather than repeated at each place that saves: every one of these
	 * was previously the caller's job to remember, and forgetting one is invisible until the
	 * setting appears not to work.
	 */
	onSettingsChanged(async (next) => {
		settings = next;
		applyNativeAppearance();
		for (const session of sessions.values()) session.updateSettings(next);
		for (const chat of sideChats.values()) chat.updateSettings(next);
		if (next.sync.enabled && !syncStatusSource()?.running) await startSync();
		else if (!next.sync.enabled && syncStatusSource()?.running) await stopSync();
		getWindow()?.webContents.send("settings:changed", next);
	});
	useSettingsSource(() => settings);
	configureHub({ store: () => store, settings: () => settings, window: getWindow, sync: syncStatusSource });
	configureSync(() => store);
	// Before the window exists, so its very first frame gets the right material.
	applyNativeAppearance();

	registerPreviewProtocols({ browserPartition: BROWSER_PARTITION, insideAProject });

	// Clear out sessions that were reserved and never used — including any left over from
	// when clicking "新对话" created one up front.
	const pruned = await store.pruneEmpty().catch(() => 0);
	if (pruned > 0) console.log(`[lyra] 清理了 ${pruned} 个空会话`);

	/*
	 * Previews outlive nothing. Anything belonging to a conversation that is gone goes with it,
	 * and what remains expires on its own after a month — otherwise every sketch ever rendered
	 * would sit in the app directory forever, since nothing else would ever think to remove it.
	 */
	void store
		.listSessions()
		.then((all) => pruneSessionArtifacts(lyraHome(), new Set(all.map((s) => s.id))))
		.then((gone) => {
			if (gone > 0) console.log(`[lyra] 清理了 ${gone} 个会话的临时文件`);
		})
		.catch(() => {});
	/*
	 * Search, working out of the box.
	 *
	 * The keyless provider is registered unconditionally so a fresh install can search at all; the
	 * keyed ones read their key at call time, so they become available the moment one is pasted in
	 * and stay out of the way until then. With more than one usable, the seam asks which — see
	 * `selectSearchProvider`.
	 */
	registerSearchProvider(duckDuckGoProvider());
	registerSearchProvider(instantAnswerProvider());
	registerSearchProvider(keyedSearchProvider(TAVILY_PROVIDER_ID, () => settings?.searchApiKeys?.tavily));
	registerSearchProvider(keyedSearchProvider(EXA_PROVIDER_ID, () => settings?.searchApiKeys?.exa));
	registerSearchProvider(keyedSearchProvider(BRAVE_PROVIDER_ID, () => settings?.searchApiKeys?.brave));

	registerIpc();
	createWindow();
	if (settings.sync.enabled) await startSync();

	scheduler = new Scheduler({
		getSettings: () => settings,
		saveSettings: async (next) => void (await applySettings(next)),
		createSession: (cwd, modelId) => getOrCreateSession(cwd, modelId),
		notify: (message, level) => getWindow()?.webContents.send("scheduler:notice", { message, level }),
	});
	scheduler.start();

	/*
	 * The status bar item, once there is something behind it worth opening.
	 *
	 * Created after the kernel and the window rather than first: every one of its menu items ends
	 * up in the renderer, and an item that is clickable before anything can answer it is a menu
	 * that silently does nothing.
	 */
	createTray({ window: getWindow, reveal, send: sendToRenderer });

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

/**
 * Bring the window up, building it first if there is none, and run `then` when it can listen.
 *
 * The second part is what makes a menu item work from cold. A freshly created window has a
 * `webContents` immediately but has not loaded the renderer yet, and anything sent in that gap is
 * dropped without a trace — the app would open on the default screen and simply ignore which item
 * had been clicked.
 */
function reveal(then?: () => void): void {
	const existing = getWindow();
	if (existing) {
		if (existing.isMinimized()) existing.restore();
		existing.show();
		existing.focus();
		then?.();
		return;
	}

	createWindow();
	const created = getWindow();
	if (!created) return;
	if (then) created.webContents.once("did-finish-load", then);
}

function sendToRenderer(command: TrayCommand): void {
	reveal(() => getWindow()?.webContents.send("tray:command", command));
}

app.on("window-all-closed", () => {
	/*
	 * With a status bar item, closing the window is not quitting.
	 *
	 * That is the whole point of having one: the agent goes on running, the schedule goes on
	 * firing, and the way back is the icon. macOS works this way for every app; Windows and Linux
	 * only should when there is something left on screen to return through — hence the check
	 * rather than an unconditional change. Quitting is on the tray menu.
	 */
	if (process.platform !== "darwin" && !hasTray()) app.quit();
});

app.on("before-quit", async () => {
	destroyTray();
	scheduler?.stop();
	for (const dispose of browsers.values()) dispose();
	browsers.clear();
	// Shells are real child processes; without this they outlive the window that opened them.
	for (const terminal of terminals.values()) terminal.kill();
	terminals.clear();
	await Promise.all([...sessions.values()].map((s) => s.dispose()));
	await stopSync();
	// Unwinds every capability the plugins installed, in the reverse of the order they arrived.
	useLlmRegistry(null);
	useToolRegistry(null);
	useSandbox(null);
	useCompaction(null);
	useApprovalPolicy(null);
	useSkillRegistry(null);
	useScheduler(null);
	useAgentLoop(null);
	useTurnPipeline(null);
	await kernel?.dispose();
	kernel = null;
});

function registerIpc(): void {
	registerWorkspaceIpc({ workspaceInfo });

	registerWindowIpc();

	registerSessionsIpc({
		store: () => store,
		settings: () => settings,
		saveSettings: async (next) => void (await applySettings(next)),
	});

	registerSideChatIpc({ sideChats, sessions, settings: () => settings, ensureSession: (id: string) => ensureLiveSession(id), broadcastSideChat });

	registerFilesIpc({ projectPath });
	registerFileOpsIpc({ projectPath });

	registerTerminalIpc({ terminals, spawnPty, insideAProject, window: () => getWindow() });
	registerUpdateIpc();

	registerServicesIpc({
		testProvider,
		sync: syncStatusSource,
		startSync,
		idleSyncStatus,
		scheduler: () => scheduler,
	});

	registerGitIpc({ insideAProject });
}
