/**
 * The window, and the colours it is born with.
 *
 * A window that appears before the renderer has painted shows the system's idea of a background
 * for a frame or two, which reads as a flash. Everything here exists to make that first frame
 * already correct: the theme is resolved from saved settings before `new BrowserWindow`, and the
 * size and position are restored from disk rather than guessed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deepwiseHome, type Settings } from "@deepwise/core";
import { BrowserWindow, ipcMain, nativeTheme, screen, shell } from "electron";

/**
 * How this module reaches the rest of the app.
 *
 * A getter rather than a value: settings change while the app runs, and a window created after a
 * change would otherwise be born with the colours from before it.
 */
let readSettings: () => Settings | undefined = () => undefined;
let mainWindow: BrowserWindow | null = null;
let vibrant = process.platform === "darwin";

export function useSettingsSource(read: () => Settings | undefined): void {
	readSettings = read;
}

/** The live window, or null between "all closed" and the next activate. */
export function getWindow(): BrowserWindow | null {
	return mainWindow;
}

interface WindowState {
	x?: number;
	y?: number;
	width: number;
	height: number;
	maximized?: boolean;
}

/**
 * The background the window itself paints, resolved from the saved appearance.
 *
 * Mirrors the renderer's own rule so the two agree from the very first frame: an explicit
 * theme wins, `system` follows the OS. Falls back to the palette defaults when settings have
 * not loaded yet, which is the case for the very first launch.
 */
export function resolvedBackground(): string {
	return bootTheme().background;
}

export function applyNativeAppearance(): void {
	const theme = readSettings()?.appearance?.theme ?? "system";
	nativeTheme.themeSource = theme === "light" || theme === "dark" ? theme : "system";
}

export function bootTheme(): { dark: boolean; background: string; foreground: string; accent: string; vibrancy: boolean } {
	const appearance = readSettings()?.appearance;
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

export function createWindow(): void {
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
		...(process.platform === "darwin" && readSettings()?.appearance?.translucentSidebar !== false
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

export function writeWindowState(): void {
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

/**
 * The two things the renderer can ask the window itself to do.
 *
 * Both are about the surface behind the page rather than the page: a fast resize exposes the
 * window's own backing colour before the renderer has reflowed, and the vibrant material has to be
 * turned off before an opaque colour is painted over it.
 */
export function registerWindowIpc(): void {
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
}
