/**
 * Screen capture overlay window manager for desktop integration.
 *
 * Creates a full-screen, frameless, transparent overlay across active displays,
 * captures background screen snapshot, and lets the user drag-to-select and annotate
 * directly on top of the frozen screen.
 */

import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, BrowserWindow, clipboard, globalShortcut, nativeImage, screen } from "electron";
import type { ScreenshotSettings, Settings } from "@lyra/core";
import { resolveSaveDirectory } from "./screenshot-path.ts";

const execFileAsync = promisify(execFile);

let overlayWindows: BrowserWindow[] = [];

/**
 * How to show each overlay, by the id of the page that will ask for it.
 *
 * Keyed on `webContents.id` so the renderer needs to send nothing but the fact that it is ready —
 * the sender identifies the window. See `revealScreenshotOverlay`.
 */
const revealers = new Map<number, () => void>();
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
 * Capture full screen snapshot quietly to a base64 data URL.
 */
async function captureFullDisplaySnapshot(displayId?: number): Promise<{ dataUrl: string; width: number; height: number; scaleFactor: number } | null> {
	if (process.platform !== "darwin") return null;

	const targetDisplay = displayId !== undefined
		? screen.getAllDisplays().find((d) => d.id === displayId) ?? screen.getPrimaryDisplay()
		: screen.getPrimaryDisplay();

	const tempPath = join(tmpdir(), `lyra_screen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`);

	try {
		// -x: do not play sound
		// -C: do not capture cursor
		const args = ["-x", "-C", tempPath];
		await execFileAsync("/usr/sbin/screencapture", args);

		const buffer = await readFile(tempPath).catch(() => null);
		await rm(tempPath, { force: true }).catch(() => {});

		if (!buffer || buffer.length === 0) return null;

		const img = nativeImage.createFromBuffer(buffer);
		const size = img.getSize();

		return {
			dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
			width: size.width,
			height: size.height,
			scaleFactor: targetDisplay.scaleFactor || 2,
		};
	} catch (err) {
		console.error("[screenshot] failed to capture full display:", err);
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
	main.show();
	main.focus();
	// The application, not just the window — see above.
	app.focus({ steal: true });
}

/**
 * Open the interactive fullscreen overlay window on the display where the cursor currently is.
 */
export async function startScreenshotSession(customSettings?: ScreenshotSettings): Promise<void> {
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
		alwaysOnTop: true,
		skipTaskbar: true,
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
	revealers.set(win.webContents.id, reveal);
	const failsafe = setTimeout(reveal, 1500);
	win.on("closed", () => {
		clearTimeout(failsafe);
		revealers.delete(win.webContents.id);
	});

	win.webContents.once("did-finish-load", () => {
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
	if (process.platform !== "darwin") return;

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
