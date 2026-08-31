/**
 * Screen capture overlay window manager for desktop integration.
 *
 * Creates a full-screen, frameless, transparent overlay across active displays,
 * captures background screen snapshot, and lets the user drag-to-select and annotate
 * directly on top of the frozen screen.
 */

import { join } from "node:path";
import { app, BrowserWindow, clipboard, desktopCapturer, globalShortcut, nativeImage, screen } from "electron";
import type { ScreenshotSettings, Settings } from "@lyra/core";
import { appIconPath } from "./window.ts";
import { resolveSaveDirectory } from "./screenshot-path.ts";


let overlayWindows: BrowserWindow[] = [];

/**
 * How to show each overlay, by the id of the page that will ask for it.
 *
 * Keyed on `webContents.id` so the renderer needs to send nothing but the fact that it is ready —
 * the sender identifies the window. See `revealScreenshotOverlay`.
 */
const revealers = new Map<number, () => void>();
/**
 * Whether Lyra was the application in front when the screenshot started.
 *
 * Decides where the foreground goes afterwards, and the two answers are opposite. Triggered from
 * inside Lyra — the composer's button, the tray — finishing should come back to Lyra, because that
 * is where the picture is going. Triggered by the global shortcut while reading something else, it
 * should not: taking a screenshot of a browser and being thrown into a different application is
 * the app barging in on work it was only meant to observe.
 *
 * What the fix for the disappearing window actually owed was "do not leave Lyra buried behind two
 * other applications with no way back" — not "always jump to the front".
 */
let cameFromApp = false;
let activeShortcut: string | null = null;
let onCaptureTriggered: (() => void) | null = null;
let currentSettingsProvider: (() => Settings | undefined) | null = null;

function generateScreenshotFilename(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const y = now.getFullYear();
	const m = pad(now.getMonth() + 1);
	const d = pad(now.getDate());
	const hh = pad(now.getHours());
	const mm = pad(now.getMinutes());
	const ss = pad(now.getSeconds());
	return `Screenshot ${y}-${m}-${d} at ${hh}.${mm}.${ss}.png`;
}

/**
 * A picture of one display, as a data URL.
 *
 * `desktopCapturer` rather than shelling out to `/usr/sbin/screencapture`. The CLI was macOS-only,
 * and the guard that said so — `if (process.platform !== "darwin") return null` — made screenshots
 * silently do nothing on Windows and Linux: the shortcut fired, no overlay appeared, no error was
 * reported. Electron's own capture works on all three.
 *
 * It also removes a round trip through the filesystem. The old path wrote a PNG to the temp
 * directory, read it back and deleted it, which is three chances to fail on a full disk and a file
 * of the user's screen sitting in `/tmp` in between.
 *
 * `thumbnailSize` is the display in *physical* pixels — `desktopCapturer` scales its thumbnail down
 * to fit whatever it is given, and a Retina screen asked for its logical size comes back at half
 * resolution. The name is misleading: this is the capture size, not a preview.
 */
async function captureFullDisplaySnapshot(displayId?: number): Promise<{ dataUrl: string; width: number; height: number; scaleFactor: number } | null> {
	const targetDisplay = displayId !== undefined
		? screen.getAllDisplays().find((d) => d.id === displayId) ?? screen.getPrimaryDisplay()
		: screen.getPrimaryDisplay();
	const scaleFactor = targetDisplay.scaleFactor || 1;

	try {
		const sources = await desktopCapturer.getSources({
			types: ["screen"],
			thumbnailSize: {
				width: Math.round(targetDisplay.bounds.width * scaleFactor),
				height: Math.round(targetDisplay.bounds.height * scaleFactor),
			},
			fetchWindowIcons: false,
		});

		if (sources.length === 0) {
			/*
			 * No sources at all is what a refused permission looks like from here.
			 *
			 * macOS does not fail the call; it returns nothing. Said plainly because the symptom
			 * otherwise is a shortcut that appears to do nothing at all.
			 */
			console.error("[screenshot] no screen sources — screen recording permission is most likely not granted");
			return null;
		}

		// `display_id` is a string on every platform, and absent on some Linux setups — falling back
		// to the first source is right there, where there is only one screen to capture.
		const source = sources.find((candidate) => candidate.display_id === String(targetDisplay.id)) ?? sources[0];
		const image = source.thumbnail;
		if (image.isEmpty()) {
			console.error("[screenshot] the captured image was empty");
			return null;
		}

		const size = image.getSize();
		return {
			dataUrl: image.toDataURL(),
			width: size.width,
			height: size.height,
			scaleFactor,
		};
	} catch (err) {
		console.error("[screenshot] failed to capture the display:", err);
		return null;
	}
}

/**
 * Show the overlay that has just finished painting its snapshot.
 *
 * Ignores anything that is not an overlay awaiting reveal, so a stray message cannot raise a
 * window; and ignores a second one, because the failsafe timer may already have shown it.
 */
export function revealScreenshotOverlay(webContentsId: number): void {
	const reveal = revealers.get(webContentsId);
	if (!reveal) return;
	revealers.delete(webContentsId);
	reveal();
}

/**
 * Close and destroy all active overlay windows, and give the app back the foreground.
 *
 * The overlay is `alwaysOnTop` at `screen-saver` level and visible on every workspace — it has to
 * be, or it cannot cover a fullscreen app to take a picture of it. What that costs is where the
 * foreground goes when it is destroyed: macOS hands it to whatever is underneath, which is
 * whatever the user happened to have open before Lyra. The main window is not hidden and not
 * closed; it is simply behind two other applications, which reads as the app having vanished —
 * the dock icon is there and clicking it does nothing, because nothing is minimised.
 *
 * So the return is made explicit. `app.focus({ steal: true })` is the part that matters on macOS:
 * showing and focusing a window belonging to an application that is not frontmost raises it within
 * that application, and leaves the application itself behind.
 */
export function closeScreenshotOverlay(options?: { restoreFocus?: boolean }): void {
	const overlays = new Set(overlayWindows);
	for (const win of overlayWindows) {
		if (!win.isDestroyed()) {
			win.destroy();
		}
	}
	overlayWindows = [];

	// Re-apply dock icon on macOS to ensure dock logo does not disappear or reset
	if (process.platform === "darwin") {
		const icon = appIconPath();
		if (icon && app.dock) {
			app.dock.setIcon(icon);
		}
	}

	// Not when another overlay is about to take its place — see the call in
	// `startScreenshotSession`. Raising the app for one frame between two overlays is a flicker.
	if (options?.restoreFocus === false) return;

	/*
	 * Whatever window is not an overlay. Found rather than injected: this module is reached from
	 * a global shortcut, from IPC and from the overlay's own completion, and threading the main
	 * window through all three to be used in one place is bookkeeping in three files.
	 */
	const main = BrowserWindow.getAllWindows().find((win) => !overlays.has(win) && !win.isDestroyed());
	if (!main) return;
	if (main.isMinimized()) main.restore();

	/*
	 * Raised within Lyra either way, so it is never buried under its own overlay's leftovers — but
	 * `showInactive`, which does not take the foreground from whatever the user is actually looking
	 * at. Only a screenshot that started from Lyra brings Lyra back.
	 */
	if (!cameFromApp) {
		main.showInactive();
		return;
	}
	main.show();
	main.focus();
	// The application, not just the window — see above.
	app.focus({ steal: true });
}

/**
 * Open the interactive fullscreen overlay window on the display where the cursor currently is.
 */
export async function startScreenshotSession(customSettings?: ScreenshotSettings): Promise<void> {
	/*
	 * Asked before anything is shown, because in a moment the overlay itself will be the focused
	 * window and the answer will always be yes. See `cameFromApp`.
	 */
	cameFromApp = BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isFocused());

	// A leftover overlay from a previous session, cleared without handing the foreground back —
	// this one is about to take it.
	closeScreenshotOverlay({ restoreFocus: false });

	const cursorPoint = screen.getCursorScreenPoint();
	const currentDisplay = screen.getDisplayNearestPoint(cursorPoint);

	const snapshot = await captureFullDisplaySnapshot(currentDisplay.id);
	if (!snapshot) return;

	const { bounds } = currentDisplay;

	const win = new BrowserWindow({
		x: bounds.x,
		y: bounds.y,
		width: bounds.width,
		height: bounds.height,
		frame: false,
		transparent: true,
		/*
		 * Hidden until the renderer has the snapshot on screen — see `reveal` below.
		 *
		 * Without this the whole handshake is dead code: `show` defaults to true, so the window is
		 * already visible by the time anything can ask for it to be revealed, and `reveal` returns
		 * at its own `isVisible()` guard having done nothing. What the user sees in the meantime is
		 * a transparent full-screen window over everything — the flicker the handshake exists to
		 * remove.
		 */
		show: false,
		alwaysOnTop: true,
		skipTaskbar: process.platform !== "darwin",
		resizable: false,
		movable: false,
		fullscreenable: false,
		hasShadow: false,
		backgroundColor: "#00000000",
		enableLargerThanScreen: true,
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			backgroundThrottling: false,
		},
	});

	// Level screen-saver makes sure it sits above normal fullscreen apps and menu bar on macOS
	win.setAlwaysOnTop(true, "screen-saver");
	win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

	// Ensure dock icon remains set on macOS when overlay starts
	if (process.platform === "darwin") {
		const icon = appIconPath();
		if (icon && app.dock) {
			app.dock.setIcon(icon);
		}
	}

	overlayWindows.push(win);

	win.on("closed", () => {
		overlayWindows = overlayWindows.filter((w) => w !== win);
	});

	// Pass snapshot data and initial settings to overlay via query / hash
	const devServer = process.env.ELECTRON_RENDERER_URL;
	const overlayUrl = devServer
		? `${devServer}#/screenshot-overlay`
		: `file://${join(import.meta.dirname, "../renderer/index.html")}#/screenshot-overlay`;

	/*
	 * Shown when the snapshot is on screen, not when the document has loaded.
	 *
	 * `did-finish-load` only means the page exists. What follows it is an IPC hop, an `Image`
	 * decoding a base64 data URL, and a React effect drawing that image to a canvas — all
	 * asynchronous. Showing the window at the start of that sequence puts an empty transparent
	 * overlay over the screen for a few frames, which is the flicker: the screen appears to blink
	 * before freezing.
	 *
	 * The renderer says when it has painted. The timeout is not a fallback for slowness — it is
	 * for a renderer that fails before it gets there, where the alternative is an invisible window
	 * swallowing every click on the screen with nothing to show for it.
	 */
	const reveal = () => {
		if (win.isDestroyed() || win.isVisible()) return;
		win.show();
		win.focus();
	};
	// Read now and kept, because `win.webContents` is not reachable from the `closed` handler that
	// has to clean this up.
	const webContentsId = win.webContents.id;
	revealers.set(webContentsId, reveal);
	const failsafe = setTimeout(reveal, 1500);
	win.on("closed", () => {
		clearTimeout(failsafe);
		revealers.delete(webContentsId);
	});

	win.webContents.once("did-finish-load", () => {
		if (win.isDestroyed() || win.webContents.isDestroyed()) return;
		win.webContents.send("screenshot:init", {
			snapshot: snapshot.dataUrl,
			bounds,
			scaleFactor: snapshot.scaleFactor,
			settings: customSettings ?? currentSettingsProvider?.()?.screenshot,
		});
	});

	if (devServer) {
		void win.loadURL(overlayUrl);
	} else {
		void win.loadFile(join(import.meta.dirname, "../renderer/index.html"), {
			hash: "/screenshot-overlay",
		});
	}
}

/**
 * Handle save/finish from overlay renderer
 */
export async function finishScreenshot(dataUrl: string, settings?: ScreenshotSettings): Promise<{ ok: boolean; filePath?: string }> {
	closeScreenshotOverlay();

	const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
	const buffer = Buffer.from(base64Data, "base64");

	// 1. Copy to clipboard
	const copyToClipboard = settings?.copyToClipboard !== false;
	if (copyToClipboard) {
		const img = nativeImage.createFromBuffer(buffer);
		clipboard.writeImage(img);
	}

	// 2. Save to file if saveLocation is configured
	let filePath: string | undefined;
	if (settings?.saveLocation?.trim()) {
		try {
			const saveDir = resolveSaveDirectory(settings.saveLocation, app.getPath("desktop"));
			const filename = generateScreenshotFilename();
			filePath = join(saveDir, filename);
			const { writeFile, mkdir } = await import("node:fs/promises");
			await mkdir(saveDir, { recursive: true });
			await writeFile(filePath, buffer);
		} catch (err) {
			console.error("[screenshot] failed to save screenshot file:", err);
		}
	}

	return { ok: true, filePath };
}

/**
 * Register global shortcut
 */
export function registerScreenshotShortcut(
	getSettings: () => Settings | undefined,
	onTrigger: () => void,
): void {
	// No platform gate: `globalShortcut` and the capture behind it work on all three. This used to
	// return early anywhere but macOS, which left the shortcut unregistered and the setting for it
	// on screen — a key combination the settings page offered to change and nothing would answer.
	currentSettingsProvider = getSettings;
	onCaptureTriggered = onTrigger;

	let shortcut = getSettings()?.screenshot?.shortcut?.trim();
	if (shortcut) {
		shortcut = shortcut.replace(/Option/gi, "Alt");
	}

	if (activeShortcut) {
		try {
			globalShortcut.unregister(activeShortcut);
		} catch {}
		activeShortcut = null;
	}

	if (!shortcut) return;

	try {
		const success = globalShortcut.register(shortcut, () => {
			void startScreenshotSession();
			onCaptureTriggered?.();
		});
		if (success) {
			activeShortcut = shortcut;
		} else {
			console.warn(`[screenshot] 快捷键注册失败: ${shortcut}`);
		}
	} catch (err) {
		console.warn(`[screenshot] 快捷键格式错误: ${shortcut}`, err);
	}
}

export function unregisterScreenshotShortcut(): void {
	if (activeShortcut) {
		try {
			globalShortcut.unregister(activeShortcut);
		} catch {}
		activeShortcut = null;
	}
	onCaptureTriggered = null;
}
