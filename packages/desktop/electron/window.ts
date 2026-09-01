/**
 * The window, and the colours it is born with.
 *
 * A window that appears before the renderer has painted shows the system's idea of a background
 * for a frame or two, which reads as a flash. Everything here exists to make that first frame
 * already correct: the theme is resolved from saved settings before `new BrowserWindow`, and the
 * size and position are restored from disk rather than guessed.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lyraHome, type Settings } from "@lyra/core";
import { app, BrowserWindow, ipcMain, nativeTheme, screen, shell } from "electron";

/**
 * Where the icon file is, packaged or not.
 *
 * Packaged, `build/` is copied next to the bundle; in development the source tree is right there.
 * Returns undefined rather than a wrong path, because Electron falls back to its own logo on a
 * missing file without saying so — and a silently wrong icon is harder to notice than none.
 */
export function appIconPath(): string | undefined {
	/*
	 * `app.getAppPath()`, not `__dirname`.
	 *
	 * The main process is built as an ES module, where `__dirname` does not exist — and reaching
	 * for it here threw inside `whenReady`, which took the rest of startup with it: no kernel, no
	 * IPC handlers, and a window whose session list came back empty for reasons that had nothing
	 * to do with sessions. Electron's own answer works packaged and unpackaged alike.
	 */
	const base = app.getAppPath();
	const candidates = [
		join(base, "build", "icon.png"),
		join(base, "..", "build", "icon.png"),
		join(process.resourcesPath ?? "", "build", "icon.png"),
	];
	return candidates.find((path) => existsSync(path));
}

/**
 * How this module reaches the rest of the app.
 *
 * A getter rather than a value: settings change while the app runs, and a window created after a
 * change would otherwise be born with the colours from before it.
 */
let readSettings: () => Settings | undefined = () => undefined;
let mainWindow: BrowserWindow | null = null;
export const sessionWindows = new Map<string, BrowserWindow>();

export function useSettingsSource(read: () => Settings | undefined): void {
	readSettings = read;
}

/** The live window, or null between "all closed" and the next activate. */
export function getWindow(): BrowserWindow | null {
	if (!mainWindow || mainWindow.isDestroyed()) return null;
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
function resolvedBackground(): string {
	return bootTheme().background;
}

export function applyNativeAppearance(): void {
	const theme = readSettings()?.appearance?.theme ?? "system";
	nativeTheme.themeSource = theme === "light" || theme === "dark" ? theme : "system";
}

export function bootTheme(): { dark: boolean; background: string; foreground: string; accent: string } {
	const appearance = readSettings()?.appearance;
	const dark = appearance
		? appearance.theme === "dark" || (appearance.theme === "system" && nativeTheme.shouldUseDarkColors)
		: nativeTheme.shouldUseDarkColors;
	return {
		dark,
		background: dark ? (appearance?.darkBackground ?? "#171717") : (appearance?.lightBackground ?? "#ffffff"),
		foreground: dark ? (appearance?.darkForeground ?? "#ededed") : (appearance?.lightForeground ?? "#1a1a1a"),
		accent: appearance?.accent ?? "#339cff",
	};
}

export function createSessionWindow(
	sessionId: string,
	initialPosition?: { x: number; y: number },
	sourceWebContents?: Electron.WebContents,
): void {
	// If the drag drop target landed on an existing window (e.g. main window or other session window),
	// merge this session into that target window as a new tab instead of opening a duplicate window!
	if (initialPosition) {
		const allWindows = BrowserWindow.getAllWindows();
		for (const targetWin of allWindows) {
			if (targetWin.isDestroyed() || !targetWin.isVisible()) continue;
			// Skip the window where the drag originated from if it's still being dragged
			if (sourceWebContents && targetWin.webContents.id === sourceWebContents.id) continue;

			const b = targetWin.getBounds();
			if (
				initialPosition.x >= b.x &&
				initialPosition.x <= b.x + b.width &&
				initialPosition.y >= b.y &&
				initialPosition.y <= b.y + b.height
			) {
				// Target window found! Dispatch tab merge IPC event
				targetWin.webContents.send("sessions:mergeTab", sessionId);
				if (targetWin.isMinimized()) targetWin.restore();
				targetWin.show();
				targetWin.focus();
				return;
			}
		}
	}

	const existing = sessionWindows.get(sessionId);
	if (existing && !existing.isDestroyed()) {
		if (existing.isMinimized()) existing.restore();
		existing.show();
		existing.focus();
		return;
	}

	const mainBounds = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : undefined;
	const winWidth = mainBounds?.width ?? 980;
	const winHeight = mainBounds?.height ?? 680;

	// Position around drop coordinates or cascade from main window
	let x = mainBounds ? mainBounds.x + 32 : undefined;
	let y = mainBounds ? mainBounds.y + 32 : undefined;
	if (initialPosition) {
		x = Math.max(0, Math.round(initialPosition.x - winWidth / 2));
		y = Math.max(0, Math.round(initialPosition.y - 30));
	}

	const win = new BrowserWindow({
		icon: appIconPath(),
		width: winWidth,
		height: winHeight,
		...(x !== undefined && y !== undefined ? { x, y } : {}),
		minWidth: 380,
		minHeight: 440,
		show: false,
		backgroundColor: resolvedBackground(),
		titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
		trafficLightPosition: { x: 16, y: 16 },
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			webviewTag: true,
			backgroundThrottling: false,
			// Read by the preload before the first frame, so the app never opens in the wrong theme.
			additionalArguments: [`--ly-boot=${encodeURIComponent(JSON.stringify(bootTheme()))}`],
		},
	});

	sessionWindows.set(sessionId, win);

	win.once("ready-to-show", () => {
		win.show();
		win.focus();
	});

	win.on("closed", () => {
		sessionWindows.delete(sessionId);
	});

	const reportMaximized = () => win?.webContents.send("window:maximized", win.isMaximized());
	win.on("maximize", reportMaximized);
	win.on("unmaximize", reportMaximized);

	win.webContents.setWindowOpenHandler(({ url }) => {
		void shell.openExternal(url);
		return { action: "deny" };
	});

	const devServer = process.env.ELECTRON_RENDERER_URL;
	const query = `?session=${encodeURIComponent(sessionId)}`;
	if (devServer) {
		void win.loadURL(`${devServer}${query}`);
	} else {
		void win.loadFile(join(import.meta.dirname, "../renderer/index.html"), {
			search: query,
		});
	}
}

export function createWindow(): void {
	const saved = readWindowState();
	mainWindow = new BrowserWindow({
		/*
		 * The icon, for the layouts that read it from the window.
		 *
		 * Windows and Linux take the taskbar icon from here; macOS takes it from the bundle, which
		 * only exists once the app is packaged — so in development it is set on the dock instead
		 * (see `main.ts`). Without both, a dev build shows Electron's own logo, which is the one
		 * thing an application icon must never be.
		 */
		icon: appIconPath(),
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
		// The chrome in the design is drawn by the renderer; keep only the traffic lights.
		titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
		// Centres the 12pt lights on the 46px toolbar row the renderer draws, matching the
		// reference where the lights line up with the sidebar toggle and nav arrows.
		trafficLightPosition: { x: 16, y: 16 },
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
			/*
			 * Keep rendering when the window is covered.
			 *
			 * Chromium suspends the rendering lifecycle for an occluded window, and `ResizeObserver`
			 * is delivered as part of that lifecycle — so a layout that reacts to its own width
			 * simply stops reacting while another app is in front. It comes back wrong: the boxes
			 * have their new sizes (layout is still computed on demand) and the component that
			 * decides between one column and two never hears about it. The file panel expanded
			 * behind a covered window and stayed in its stacked form at a thousand pixels wide.
			 *
			 * This app also streams a transcript and runs terminals in the background, neither of
			 * which should slow down because something else is in front.
			 */
			backgroundThrottling: false,
			// Read by the preload before the first frame, so the app never opens in the wrong theme.
			additionalArguments: [`--ly-boot=${encodeURIComponent(JSON.stringify(bootTheme()))}`],
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

	const reportMaximized = () => mainWindow?.webContents.send("window:maximized", mainWindow.isMaximized());
	mainWindow.on("maximize", reportMaximized);
	mainWindow.on("unmaximize", reportMaximized);

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
	return join(lyraHome(), "window.json");
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

/**
 * What the renderer can ask the window itself to do.
 *
 * About the surface behind the page rather than the page: a fast resize exposes the window's own
 * backing colour before the renderer has reflowed, so that colour has to track the theme.
 */
export function registerWindowIpc(): void {
	ipcMain.handle("window:minimize", (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		win?.minimize();
	});
	ipcMain.handle("window:maximize", (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (win?.isMaximized()) win.unmaximize();
		else win?.maximize();
	});
	ipcMain.handle("window:unmaximize", (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		win?.unmaximize();
	});
	ipcMain.handle("window:close", (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		win?.close();
	});
	ipcMain.handle("window:is-maximized", (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		return win?.isMaximized() ?? false;
	});

	ipcMain.on("window:theme", (_event, colors: { color: string; symbolColor: string }) => {
		for (const window of BrowserWindow.getAllWindows()) {
			if (window.isDestroyed()) continue;
			window.setBackgroundColor(colors.color);
			if (process.platform !== "darwin") {
				try {
					window.setTitleBarOverlay({ ...colors, height: 38 });
				} catch {}
			}
		}
	});
}
