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
	useCompaction,
	useLlmRegistry,
	useSandbox,
	useSkillRegistry,
	useToolRegistry,
	COMPACTION,
	LLM,
	SANDBOX,
	SKILLS,
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
	type CompactionStrategy,
	type Context as CapabilityContext,
	type ContextBreakdown,
	type LlmRegistry,
	type Sandbox,
	type Settings,
	type SkillRegistry,
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
import { registerFilesIpc } from "./ipc/files.ts";
import { registerGitIpc } from "./ipc/git.ts";
import { registerSideChatIpc } from "./ipc/side-chat.ts";
import { registerPluginsIpc } from "./ipc/plugins.ts";
import { registerSystemIpc } from "./ipc/system.ts";
import { registerTerminalIpc } from "./ipc/terminal.ts";
import { Scheduler } from "./scheduler.ts";
import { SyncServer } from "./sync-server.ts";

const execFileAsync = promisify(execFile);

/** Private scheme the renderer uses to preview images and video from the open project. */
const MEDIA_SCHEME = "dw-media";
/**
 * Previews get a scheme of their own, and deliberately not `file://`.
 *
 * A page the agent wrote is untrusted code. Served from its own origin it is subject to the
 * normal same-origin rules, cannot read the user's disk by walking `file:///`, and can be
 * pinned to a directory by the handler below — none of which is true of a file URL.
 */
const PREVIEW_SCHEME = "dw-preview";
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

const store = new SessionStore();
/** Live sessions keyed by session id. A session stays warm so MCP servers are not respawned per turn. */
const sessions = new Map<string, AgentSession>();
/** The capability context: what the app can do, assembled from plugins at boot. */
let kernel: CapabilityContext | null = null;
/** Per-session browser instances, disposed alongside the session that owns them. */
const browsers = new Map<string, () => void>();
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
let mainWindow: BrowserWindow | null = null;
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

/**
 * The background the window itself paints, resolved from the saved appearance.
 *
 * Mirrors the renderer's own rule so the two agree from the very first frame: an explicit
 * theme wins, `system` follows the OS. Falls back to the palette defaults when settings have
 * not loaded yet, which is the case for the very first launch.
 */
function resolvedBackground(): string {
	return bootTheme().background;
}

/**
 * The theme the very first painted frame should already be wearing.
 *
 * The renderer cannot work this out in time: the stylesheet ships one palette, and the real one
 * only arrives after `settings:get` resolves — several frames in. So a light-theme app opened
 * dark and then snapped, every launch. The main process has the settings on disk before the
 * window exists, so it hands the answer to the preload, which paints it before the first frame.
 */
/**
 * Tell the OS which appearance this window is in.
 *
 * macOS draws the sidebar's vibrancy itself, and picks the material from the *window's*
 * appearance — which, left alone, is whatever the system is set to. So a light app on a dark
 * system got a dark material under a 72%-white sidebar, and the sidebar came out grey while
 * every pixel the renderer painted was correct. Nothing in CSS can reach that layer; the
 * window has to be told.
 *
 * It also settles the native menus, dialogs and scrollbars, which have the same problem for
 * the same reason.
 */
/** Enough of a MIME table for a self-contained page; anything else is served as bytes. */
/**
 * Let a preview say how tall it wants to be.
 *
 * The card cannot ask: the page is on its own origin inside a sandbox with no same-origin, so
 * nothing in the app can read its layout. The page can volunteer the number, though, and
 * `postMessage` crosses that boundary in the one safe direction — a bare integer, going out.
 *
 * Injected rather than required of the agent, because a page that had to remember to include
 * this would sometimes forget, and the sizing would be right only some of the time.
 */
function withHeightReporter(html: string): string {
	/*
	 * Two ways to measure, because either one alone is wrong half the time.
	 *
	 * If the document already scrolls, the content has outgrown the viewport and `scrollHeight` is
	 * exactly the answer. If it does not, the page has been asked how tall it is while filling the
	 * space it was given — `height: 100vh`, a centred grid, a flex column — and it will keep
	 * answering with that space no matter what space we offer.
	 *
	 * For that second case the height rules are lifted and the content is left to compose itself.
	 * That measurement has its own blind spot, which is why it is not used for everything: a page
	 * whose inner boxes are sized in percentages collapses without a height to be a percentage of,
	 * and reports far less than it draws. Restored in the same task, so nothing is ever painted in
	 * the measured state.
	 */
	/*
	 * A classic feedback loop, cut at the source.
	 *
	 * Measure the content, size the card to it, and a page that lands a pixel over its allowance
	 * grows a scrollbar. The scrollbar takes width from the content, the content rewraps and gets
	 * taller, and now it really does overflow — the bar earns its own existence, and every preview
	 * ends up with a grey rail down one side that nothing asked for.
	 *
	 * Removing it from the layout ends the loop: an overlay scrollbar takes no width, so measuring
	 * and displaying agree.
	 *
	 * Hiding the rail was not enough on its own, though. A page left a pixel over its allowance
	 * still scrolls — it wobbles under the wheel, and worse, it swallows the gesture, so scrolling
	 * with the pointer over a preview stops moving the conversation behind it. Inside the card the
	 * page therefore does not scroll at all: it was measured to fit, and anything that genuinely
	 * needs more room has the side panel, where scrolling is what you came for. `dw-inline` is set
	 * by the card and by nothing else, so the same file scrolls normally when opened there.
	 */
	const style = `<style>html.dw-inline,html.dw-inline body{overflow:hidden!important}html{scrollbar-width:none}html::-webkit-scrollbar,body::-webkit-scrollbar{width:0;height:0;display:none}</style>`;
	const script = `<script>(function(){
/* Set before first paint, so the page is never briefly scrollable. */
if(location.hash==="#dw-inline"&&document.documentElement)document.documentElement.className+=" dw-inline";
var last=0;
function measure(){
var b=document.body,d=document.documentElement;
if(!b||!d)return 0;
var scroll=Math.max(b.scrollHeight,d.scrollHeight);
if(scroll>d.clientHeight+2)return scroll;
var keep=[[b,b.style.height,b.style.minHeight],[d,d.style.height,d.style.minHeight]];
b.style.height="auto";b.style.minHeight="0";
d.style.height="auto";d.style.minHeight="0";
var natural=Math.max(b.scrollHeight,b.offsetHeight);
for(var i=0;i<keep.length;i++){keep[i][0].style.height=keep[i][1];keep[i][0].style.minHeight=keep[i][2];}
return natural;
}
function report(){
/* A pixel of slack. Sub-pixel layout rounds up as often as down, and with overflow hidden the
   difference is not a scrollbar any more — it is a clipped row of text. */
var h=measure();if(h)h+=2;
if(h&&Math.abs(h-last)>2){last=h;try{parent.postMessage({__dwPreviewHeight:h},"*")}catch(e){}}
}
addEventListener("load",report);addEventListener("resize",report);
if(window.ResizeObserver&&document.documentElement)new ResizeObserver(report).observe(document.documentElement);
setTimeout(report,50);setTimeout(report,200);setTimeout(report,500);setTimeout(report,1200);
})();</script>`;
	// Before the page's own scripts, so a page that never finishes loading still reports.
	const head = html.match(/<head[^>]*>/i);
	if (head) return html.replace(head[0], `${head[0]}${style}${script}`);
	return style + script + html;
}

function contentTypeFor(path: string): string {
	const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
	return (
		{
			".html": "text/html; charset=utf-8",
			".css": "text/css; charset=utf-8",
			".js": "text/javascript; charset=utf-8",
			".json": "application/json; charset=utf-8",
			".svg": "image/svg+xml",
			".png": "image/png",
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".gif": "image/gif",
			".webp": "image/webp",
		}[ext] ?? "application/octet-stream"
	);
}

function applyNativeAppearance(): void {
	const theme = settings?.appearance?.theme ?? "system";
	nativeTheme.themeSource = theme === "light" || theme === "dark" ? theme : "system";
}

function bootTheme(): { dark: boolean; background: string; foreground: string; accent: string; vibrancy: boolean } {
	const appearance = settings?.appearance;
	const dark = appearance
		? appearance.theme === "dark" || (appearance.theme === "system" && nativeTheme.shouldUseDarkColors)
		: nativeTheme.shouldUseDarkColors;
	return {
		dark,
		background: dark ? (appearance?.darkBackground ?? "#171717") : (appearance?.lightBackground ?? "#ffffff"),
		foreground: dark ? (appearance?.darkForeground ?? "#ededed") : (appearance?.lightForeground ?? "#1a1a1a"),
		accent: appearance?.accent ?? "#339cff",
		vibrancy: process.platform === "darwin" && appearance?.translucentSidebar !== false,
	};
}

function createWindow(): void {
	const saved = readWindowState();
	mainWindow = new BrowserWindow({
		// Matches the reference screenshots: a 272px sidebar plus a main column wide enough
		// for the four suggestion cards to sit on one row.
		width: saved?.width ?? 980,
		height: saved?.height ?? 680,
		...(saved && saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
		/*
		 * Small enough for the phone-shaped layout the renderer switches to below 760pt: the
		 * sidebar becomes a drawer, the cards stack two by two, and the composer keeps its
		 * send button. 380×440 is where the composer controls stop fitting on one row.
		 */
		minWidth: 380,
		minHeight: 440,
		show: false,
		/*
		 * The window's own backing colour, which is what shows through whenever the native
		 * resize outpaces the renderer's reflow — dragging an edge quickly is exactly that.
		 *
		 * Hard-coded dark, it flashed a black frame on every drag under a light theme. Seeded
		 * from the saved appearance here, and kept in step by `window:theme` afterwards.
		 */
		backgroundColor: resolvedBackground(),
		/*
		 * macOS vibrancy, which is what "半透明侧边栏" actually means.
		 *
		 * A translucent colour on the sidebar alone would show the window's own opaque background
		 * through it — the same flat tone, at less contrast. What makes a sidebar translucent is
		 * the compositor sampling the desktop behind the window, and only the platform can do
		 * that. Windows has its own material and Linux has none, so this is darwin-only.
		 */
		...(process.platform === "darwin" && settings?.appearance?.translucentSidebar !== false
			? {
					vibrancy: "sidebar" as const,
					// Otherwise the material follows focus and flattens whenever another app is in front.
					visualEffectState: "active" as const,
					backgroundColor: "#00000000",
				}
			: {}),
		// The chrome in the design is drawn by the renderer; keep only the traffic lights.
		titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
		// Centres the 12pt lights on the 46px toolbar row the renderer draws, matching the
		// reference where the lights line up with the sidebar toggle and nav arrows.
		trafficLightPosition: { x: 16, y: 16 },
		// Windows/Linux draw their own controls into this strip. The colours are a starting
		// point; the renderer sends the real ones once the theme is resolved.
		...(process.platform !== "darwin"
			? { titleBarOverlay: { color: resolvedBackground(), symbolColor: "#9a9a9a", height: 44 } }
			: {}),
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			/*
			 * Needed for the browser panel, which hosts pages in a `<webview>`.
			 *
			 * The tag only lets us create one; each `<webview>` still gets its own process with
			 * node off, context isolation on and no preload, so the page inside it can render and
			 * nothing else. That separation is the reason to use it rather than an iframe: a page
			 * that hangs or crashes takes its own process down and leaves the app alone.
			 */
			webviewTag: true,
			// Read by the preload before the first frame, so the app never opens in the wrong theme.
			additionalArguments: [`--dw-boot=${encodeURIComponent(JSON.stringify(bootTheme()))}`],
		},
	});

	mainWindow.once("ready-to-show", () => mainWindow?.show());

	// Persist on settle rather than on every resize event, which fires per frame while dragging.
	let saveTimer: NodeJS.Timeout | undefined;
	const rememberLater = () => {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(writeWindowState, 400);
	};
	mainWindow.on("resize", rememberLater);
	mainWindow.on("move", rememberLater);
	mainWindow.on("close", () => {
		clearTimeout(saveTimer);
		writeWindowState();
	});

	/*
	 * Native full screen, which the renderer cannot see for itself.
	 *
	 * On macOS the traffic lights go away in full screen, and everything drawn at the top-left
	 * is inset to clear them — a gap held open for three buttons that are no longer there. There
	 * is no CSS or DOM signal for this: `titlebar-area-*` is the Windows overlay API, and the
	 * lights are drawn by the system outside the page entirely. So the window says so itself.
	 */
	const reportFullScreen = () => mainWindow?.webContents.send("window:fullscreen", mainWindow.isFullScreen());
	mainWindow.on("enter-full-screen", reportFullScreen);
	mainWindow.on("leave-full-screen", reportFullScreen);
	// The window can be restored into full screen, so the first frame has to be told as well.
	mainWindow.webContents.on("did-finish-load", reportFullScreen);

	// External links open in the user's browser, never inside the app shell.
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		void shell.openExternal(url);
		return { action: "deny" };
	});

	const devServer = process.env.ELECTRON_RENDERER_URL;
	if (devServer) void mainWindow.loadURL(devServer);
	else void mainWindow.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

interface WindowState {
	width: number;
	height: number;
	x?: number;
	y?: number;
}

function windowStatePath(): string {
	return join(deepwiseHome(), "window.json");
}

/**
 * Restore the size the user last chose.
 *
 * Someone who drags the window down to a phone-shaped column means it, and reopening at 980
 * every time undoes that. The saved bounds are only trusted if they still land on a display
 * that exists — an external monitor that has since been unplugged would otherwise put the
 * window somewhere unreachable.
 */
function readWindowState(): WindowState | null {
	try {
		const raw = JSON.parse(readFileSync(windowStatePath(), "utf8")) as Partial<WindowState>;
		if (typeof raw.width !== "number" || typeof raw.height !== "number") return null;
		const state: WindowState = { width: Math.max(380, raw.width), height: Math.max(440, raw.height) };
		if (typeof raw.x === "number" && typeof raw.y === "number") {
			const visible = screen.getAllDisplays().some((display) => {
				const b = display.workArea;
				return raw.x! < b.x + b.width && raw.x! + state.width > b.x && raw.y! < b.y + b.height && raw.y! + 40 > b.y;
			});
			if (visible) {
				state.x = raw.x;
				state.y = raw.y;
			}
		}
		return state;
	} catch {
		return null;
	}
}

function writeWindowState(): void {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	// Fullscreen and maximised bounds are the screen's, not the user's choice of window size.
	if (mainWindow.isFullScreen() || mainWindow.isMaximized() || mainWindow.isMinimized()) return;
	const { width, height, x, y } = mainWindow.getBounds();
	try {
		writeFileSync(windowStatePath(), JSON.stringify({ width, height, x, y }));
	} catch {
		// A window that cannot remember its size is not worth failing a launch over.
	}
}

/**
 * Private scheme for previewing media from the open project.
 *
 * Registered before `ready` because privileges cannot be granted afterwards. `stream: true` is
 * what lets a `<video>` issue range requests and seek; without it the whole file has to arrive
 * before the first frame. `supportFetchAPI` lets the handler answer with a `Response`.
 *
 * Not `file://`: that would hand the renderer the entire disk. This one goes through a handler
 * that re-checks the project boundary on every request.
 */
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
	useCompaction(kernel.require<CompactionStrategy>(COMPACTION));
	useSkillRegistry(kernel.require<SkillRegistry>(SKILLS));

	settings = await loadSettings();
	// Before the window exists, so its very first frame gets the right material.
	applyNativeAppearance();

	/*
	 * `dw-media://f/<encoded absolute path>`.
	 *
	 * Decoding it here is the only place it becomes a path again — and the only place it is
	 * checked. A request for anything outside an open project is refused, not served.
	 */
	protocol.handle(MEDIA_SCHEME, async (request) => {
		const target = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ""));
		if (!target || !insideAProject(target)) return new Response("forbidden", { status: 403 });
		return net.fetch(pathToFileURL(target).toString(), { headers: request.headers, method: request.method });
	});
	/*
	 * `dw-preview://<sessionId>/<previewId>/<file>`.
	 *
	 * Resolved against the previews directory and refused if it lands anywhere else, so a page
	 * asking for `../../../.ssh/id_rsa` gets a 403 rather than a key. This is the only door
	 * these files have.
	 */
	const servePreview = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const root = previewsHome(deepwiseHome());
		const target = resolve(root, url.hostname, decodeURIComponent(url.pathname).replace(/^\//, ""));
		if (target !== root && !target.startsWith(root + sep)) return new Response("forbidden", { status: 403 });
		const body = await readFile(target).catch(() => null);
		if (!body) return new Response("not found", { status: 404 });
		const type = contentTypeFor(target);
		const payload = type.startsWith("text/html") ? withHeightReporter(body.toString("utf8")) : body;
		return new Response(payload, { headers: { "content-type": type } });
	};
	protocol.handle(PREVIEW_SCHEME, servePreview);
	/*
	 * And again for the browser panel's session.
	 *
	 * `protocol.handle` registers against the default session only, and the panel's `<webview>`
	 * runs in a partition of its own — which is the point, since a page the agent wrote should
	 * not share cookies with anything. The cost is that the partition starts out not knowing this
	 * scheme exists, so "open in the side panel" landed on a blank page until it was told.
	 */
	session.fromPartition(BROWSER_PARTITION).protocol.handle(PREVIEW_SCHEME, servePreview);

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
			mainWindow?.webContents.send("settings:changed", next);
		},
		createSession: (cwd, modelId) => getOrCreateSession(cwd, modelId),
		notify: (message, level) => mainWindow?.webContents.send("scheduler:notice", { message, level }),
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
	await kernel?.dispose();
	kernel = null;
});

// ---------------------------------------------------------------------------
// Session plumbing
// ---------------------------------------------------------------------------

function broadcast(sessionId: string, event: AgentEvent): void {
	mainWindow?.webContents.send("agent:event", { sessionId, event });
	syncServer?.broadcast(sessionId, event);
}

/**
 * Side-chat events go to this window and nowhere else.
 *
 * Not to the sync server: the side chat is memory-only and belongs to the machine you are
 * sitting at. A phone replaying the session log would have no conversation to attach these to.
 */
function broadcastSideChat(sessionId: string, event: AgentEvent): void {
	mainWindow?.webContents.send("sidechat:event", { sessionId, event });
}

async function getOrCreateSession(cwd: string, modelId: string): Promise<AgentSession> {
	const browser = createBrowserTools();
	// `emit` closes over `session`, which is only ever invoked after `initialize()` has
	// assigned `meta`, so the self-reference is safe — but it needs an explicit type.
	const session: AgentSession = new AgentSession({
		cwd,
		settings,
		store,
		extraTools: browser.tools,
		emit: (event: AgentEvent) => broadcast(session.meta.id, event),
	});
	await session.initialize();
	sessions.set(session.meta.id, session);
	browsers.set(session.meta.id, browser.dispose);
	return session;
}

/**
 * How many sessions stay warm.
 *
 * Each one owns its MCP servers — real child processes — plus a headless browser, so an
 * unbounded map meant an afternoon of browsing left a dozen sets of them running. Three keeps
 * the conversations you are actually moving between instant without hoarding processes.
 */
const MAX_LIVE_SESSIONS = 3;

/** Move a session to the end of the map, which is the recency order eviction walks. */
function touchSession(sessionId: string): void {
	const session = sessions.get(sessionId);
	if (!session) return;
	sessions.delete(sessionId);
	sessions.set(sessionId, session);
}

async function snapshot(session: AgentSession): Promise<SessionSnapshot> {
	return {
		meta: session.meta,
		messages: session.messages,
		running: session.running,
		pendingApprovals: session.listPendingApprovals().map(({ id, request }) => ({
			id,
			kind: request.kind,
			title: request.title,
			detail: request.detail,
		})),
	};
}

async function startSync(): Promise<SyncStatus> {
	if (!syncServer) {
		syncServer = new SyncServer({
			getSettings: () => settings,
			saveSettings: async (next) => {
				settings = next;
				await saveSettings(next);
				mainWindow?.webContents.send("settings:changed", next);
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
		if (!mainWindow) return null;
		const result = await dialog.showOpenDialog(mainWindow, {
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
		if (process.platform !== "darwin" || !mainWindow) return;
		vibrant = on;
		mainWindow.setVibrancy(on ? "sidebar" : null);
		mainWindow.setBackgroundColor(on ? "#00000000" : resolvedBackground());
	});

	ipcMain.on("window:theme", (_event, colors: { color: string; symbolColor: string }) => {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		/*
		 * Repaint the window's own backing colour, not just the OS-drawn controls.
		 *
		 * This is the surface a fast resize exposes before the renderer has reflowed, so it has
		 * to track the theme — otherwise dragging an edge flashes the old palette's background.
		 */
		if (!vibrant) mainWindow.setBackgroundColor(colors.color);
		if (process.platform === "darwin") return;
		try {
			mainWindow.setTitleBarOverlay({ ...colors, height: 44 });
		} catch {}
	});


	ipcMain.handle("workspace:reveal", async (_event, path: string) => {
		shell.showItemInFolder(path);
	});

	ipcMain.handle("sessions:list", async () => store.listSessions());

	/** Tear down a live session's agent, MCP servers and browser. Safe to call for unknown ids. */
	async function disposeSession(sessionId: string): Promise<void> {
		await sessions.get(sessionId)?.dispose();
		browsers.get(sessionId)?.();
		browsers.delete(sessionId);
		// A side chat reads its session's live message list; without the session it has nothing
		// to read, so it goes at the same time.
		sideChats.get(sessionId)?.abort();
		sideChats.delete(sessionId);
		sessions.delete(sessionId);
	}

	/** Retire the least recently used sessions, never one mid-turn and never the current one. */
	async function evictStaleSessions(keep: string): Promise<void> {
		for (const [id, session] of [...sessions]) {
			if (sessions.size <= MAX_LIVE_SESSIONS) break;
			// An open side chat is a conversation in progress, same as a running turn — evicting
			// its session would silently throw that conversation away.
			if (id === keep || session.running || sideChats.has(id)) continue;
			await disposeSession(id);
		}
	}

	/**
	 * Bring a session up: replay its log, load its skills, spawn its MCP servers.
	 *
	 * This is the expensive half of opening a conversation, so it only runs when something is
	 * about to be executed in it — never for a read.
	 */
	async function activateSession(projectId: string, sessionId: string): Promise<AgentSession | null> {
		const existing = sessions.get(sessionId);
		if (existing) {
			touchSession(sessionId);
			return existing;
		}

		const loaded = await store.load(projectId, sessionId);
		if (!loaded) return null;
		const browser = createBrowserTools();
		const session = new AgentSession({
			cwd: loaded.meta.cwd,
			settings,
			store,
			meta: loaded.meta,
			extraTools: browser.tools,
			emit: (event) => broadcast(sessionId, event),
		});
		session.messages = loaded.messages;
		await session.initialize();
		sessions.set(sessionId, session);
		browsers.set(sessionId, browser.dispose);
		await evictStaleSessions(sessionId);
		return session;
	}

	/**
	 * The session for an id, starting it if it is only on disk.
	 *
	 * Callers that act on a session — prompting, changing its model — have a session id but no
	 * project id, so the project is recovered from the index.
	 */
	async function ensureSession(sessionId: string): Promise<AgentSession | null> {
		const existing = sessions.get(sessionId);
		if (existing) {
			touchSession(sessionId);
			return existing;
		}
		const meta = (await store.listSessions()).find((s) => s.id === sessionId);
		return meta ? activateSession(meta.projectId, sessionId) : null;
	}

	ipcMain.handle("sessions:create", async (_event, cwd: string, modelId: string) => {
		const session = await getOrCreateSession(cwd, modelId);
		if (modelId) await session.setModel(modelId);
		return snapshot(session);
	});

	/**
	 * Read a transcript without starting anything.
	 *
	 * Opening a session used to build an `AgentSession` — loading skills, spawning MCP child
	 * processes, warming the index — which costs well over a second and is pure waste when all
	 * you did was click a row to read what it says. Reading the log takes a few milliseconds;
	 * the agent is started later, by `ensureSession`, when there is actually something to run.
	 */
	ipcMain.handle("sessions:transcript", async (_event, projectId: string, sessionId: string) => {
		// A live session is the authority — it holds messages from the turn in flight and
		// knows whether it is running.
		const live = sessions.get(sessionId);
		if (live) {
			touchSession(sessionId);
			return snapshot(live);
		}

		const loaded = await store.load(projectId, sessionId);
		if (!loaded) return null;
		return {
			meta: loaded.meta,
			messages: loaded.messages,
			running: false,
			pendingApprovals: [],
			compactions: loaded.compactions,
		};
	});

	ipcMain.handle("sessions:open", async (_event, projectId: string, sessionId: string) => {
		const session = await activateSession(projectId, sessionId);
		return session ? snapshot(session) : null;
	});

	ipcMain.handle("sessions:remove", async (_event, projectId: string, sessionId: string) => {
		await disposeSession(sessionId);
		await store.delete(projectId, sessionId);
		await removeSessionArtifacts(deepwiseHome(), sessionId);
	});

	ipcMain.handle(
		"sessions:setArchived",
		async (_event, projectId: string, sessionId: string, archived: boolean) => {
			// An archived session has no reason to keep its MCP servers and browser alive.
			if (archived) await disposeSession(sessionId);
			await store.setArchived(projectId, sessionId, archived);
			return store.listSessions();
		},
	);

	ipcMain.handle("sessions:removeArchived", async () => {
		const archived = (await store.listSessions()).filter((s) => s.archived);
		await Promise.all(archived.map((s) => disposeSession(s.id)));
		await store.deleteMany(archived.map((s) => ({ projectId: s.projectId, id: s.id })));
		await Promise.all(archived.map((s) => removeSessionArtifacts(deepwiseHome(), s.id)));
		return store.listSessions();
	});

	/*
	 * Starts the agent if it is not up yet, which is a real cost — skills, plugins, MCP child
	 * processes — paid to answer a question about token counts.
	 *
	 * Worth it because clicking this is deliberate, and because the alternative is worse: opening
	 * a session only reads its transcript, so on any conversation you have not yet written to,
	 * the breakdown would be permanently empty. A panel that is blank exactly when you go looking
	 * is not a cheaper panel, it is a broken one. Anyone opening it is about to use this session
	 * anyway, so the agent it warms is one that was going to start moments later regardless.
	 */
	ipcMain.handle("sessions:contextBreakdown", async (_event, sessionId: string): Promise<ContextBreakdown | null> => {
		const session = await ensureSession(sessionId);
		return session ? session.contextBreakdown() : null;
	});

	ipcMain.handle("sessions:capabilities", async (_event, sessionId: string): Promise<AgentCapabilities | null> => {
		const session = sessions.get(sessionId);
		if (!session) return null;
		touchSession(sessionId);
		const status = await session.status();
		return {
			skills: status.skills,
			skillDiagnostics: status.skillDiagnostics,
			plugins: status.plugins,
			pluginDiagnostics: status.pluginDiagnostics,
			mcp: status.mcp,
			agents: status.agents.map((a) => ({
				name: a.name,
				description: a.description,
				source: a.source,
				tools: a.tools,
			})),
			toolNames: status.toolNames,
		};
	});

	ipcMain.handle("agent:prompt", async (_event, sessionId: string, content: UserContent[]) => {
		const session = await ensureSession(sessionId);
		if (!session) throw new Error(`Session ${sessionId} is not open.`);
		// Deliberately not awaited: the turn streams events back over IPC and can run for minutes.
		void session.prompt(content).catch((error: unknown) => {
			broadcast(sessionId, {
				type: "notice",
				level: "error",
				message: error instanceof Error ? error.message : String(error),
			});
			broadcast(sessionId, { type: "agent_end", reason: "error", error: String(error) });
		});
	});

	ipcMain.handle(
		"agent:editMessage",
		async (_event, sessionId: string, messageIndex: number, content: UserContent[]) => {
			const session = await ensureSession(sessionId);
			if (!session) throw new Error(`Session ${sessionId} is not open.`);
			// Not awaited, same as `prompt`: the re-run streams back over IPC and can take minutes.
			void session.editAndResend(messageIndex, content).catch((error: unknown) => {
				broadcast(sessionId, {
					type: "notice",
					level: "error",
					message: error instanceof Error ? error.message : String(error),
				});
				broadcast(sessionId, { type: "agent_end", reason: "error", error: String(error) });
			});
		},
	);

	ipcMain.handle("agent:abort", async (_event, sessionId: string) => {
		sessions.get(sessionId)?.abort();
	});

	ipcMain.handle("agent:approve", async (_event, sessionId: string, requestId: string, decision: ApprovalDecision) => {
		const session = sessions.get(sessionId);
		if (!session) return;
		session.resolveApproval(requestId, decision);
		if (decision === "always") {
			const request = session.listPendingApprovals().find((p) => p.id === requestId);
			if (request && !settings.alwaysAllow.includes(request.request.subject)) {
				settings = { ...settings, alwaysAllow: [...settings.alwaysAllow, request.request.subject] };
				await saveSettings(settings);
			}
		}
	});

	ipcMain.handle("agent:setModel", async (_event, sessionId: string, modelId: string) => {
		const live = sessions.get(sessionId);
		if (live) {
			// Returns false once the conversation has started; the model is settled by then.
			await live.setModel(modelId);
			return;
		}
		// Not warm: write the choice straight to the log rather than starting an agent for it.
		// The same rule applies — a stored session with messages keeps the model it ran on.
		const meta = (await store.listSessions()).find((s) => s.id === sessionId);
		if (meta && meta.messageCount === 0) await store.append(meta, { type: "meta", meta: { ...meta, modelId } });
	});

	registerSideChatIpc({ sideChats, sessions, settings: () => settings, ensureSession, broadcastSideChat });

	registerFilesIpc({ insideAProject });

	registerTerminalIpc({ terminals, spawnPty, insideAProject, window: () => mainWindow });

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
	registerPluginsIpc({ pluginsDir, writeExamplePlugin, disabledPlugins: () => settings.disabledPlugins });

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

function pluginsDir(scope: "workspace" | "user", cwd: string): string {
	return scope === "workspace" ? join(cwd, ".deepwise", "plugins") : join(deepwiseHome(), "plugins");
}

/**
 * Write a working example bundle.
 *
 * The format is only obvious once you have seen one, so this ships a manifest, a skill with a
 * real script, and an MCP declaration pointing at Context7 — the three pieces a plugin can carry.
 */
async function writeExamplePlugin(dir: string): Promise<void> {
	await mkdir(join(dir, ".deepwise-plugin"), { recursive: true });
	await mkdir(join(dir, "skills", "changelog", "scripts"), { recursive: true });

	await writeFile(
		join(dir, ".deepwise-plugin", "plugin.json"),
		`${JSON.stringify(
			{
				name: "hello-deepwise",
				version: "0.1.0",
				description: "示例插件：一个技能 + 配套脚本 + 一个 MCP 服务器。",
				author: { name: "You" },
				skills: "./skills/",
				mcpServers: "./.mcp.json",
				interface: {
					displayName: "Hello DeepWise",
					shortDescription: "示例插件，演示技能、脚本与 MCP 的打包方式",
					category: "Developer Tools",
					capabilities: ["Read", "Write"],
					brandColor: "#339CFF",
					defaultPrompt: ["用 changelog 技能整理最近的提交"],
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	await writeFile(
		join(dir, ".mcp.json"),
		`${JSON.stringify(
			{ mcpServers: { context7: { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp@latest"] } } },
			null,
			2,
		)}\n`,
		"utf8",
	);

	await writeFile(
		join(dir, "skills", "changelog", "SKILL.md"),
		[
			"---",
			"name: changelog",
			"description: 整理 git 提交为分类变更日志。当用户要求写 changelog、发布说明、版本变更时使用。",
			"---",
			"",
			"# 整理变更日志",
			"",
			"1. 运行本技能自带的脚本拿到结构化提交：",
			"   `bash scripts/collect.sh 30`",
			"2. 按 Added / Changed / Fixed 归类",
			"3. 每条一句话，写清楚对用户的影响，不要写实现细节",
			"",
			"脚本路径相对于本技能目录，调用时请使用系统提示里给出的绝对路径。",
			"",
		].join("\n"),
		"utf8",
	);

	await writeFile(
		join(dir, "skills", "changelog", "scripts", "collect.sh"),
		[
			"#!/usr/bin/env bash",
			"# Print the last N commits as `hash\\tsubject`, newest first.",
			"set -euo pipefail",
			'git log --oneline --no-merges -n "${1:-20}" --pretty=format:"%h%x09%s"',
			"",
		].join("\n"),
		{ encoding: "utf8", mode: 0o755 },
	);
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
