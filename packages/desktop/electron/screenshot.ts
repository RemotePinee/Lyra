/**
 * Screen capture overlay window manager for desktop integration.
 *
 * A prewarmed, no-activate transparent window appears as soon as its renderer is ready. The raw
 * display snapshot is captured independently and is used only as the crop/annotation source; it is
 * never painted across the desktop, so entering capture mode changes only the cursor.
 */

import { join } from "node:path";
import { app, BrowserWindow, clipboard, desktopCapturer, globalShortcut, nativeImage, screen } from "electron";
import type { ScreenshotSettings, Settings } from "@lyra/core";

import { resolveSaveDirectory } from "./screenshot-path.ts";
import { findScreenshotReturnWindow, markScreenshotWindow, ScreenshotRendererGate } from "./screenshot-window.ts";
import { detectVisibleWindows, hwndFromNativeHandle } from "./window-detect.ts";

let overlayWindows: BrowserWindow[] = [];
let prewarmedOverlay: BrowserWindow | null = null;
const screenshotRendererGate = new ScreenshotRendererGate();

function overlayBounds(bounds: Electron.Rectangle): Electron.BrowserWindowConstructorOptions {
	return {
		x: bounds.x,
		y: bounds.y,
		width: bounds.width,
		height: bounds.height,
		frame: false,
		transparent: true,
		show: false,
		focusable: false,
		alwaysOnTop: true,
		skipTaskbar: process.platform !== "darwin",
		resizable: false,
		movable: false,
		fullscreenable: false,
		hasShadow: false,
		backgroundColor: "#00000000",
		enableLargerThanScreen: true,
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/screenshot.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			backgroundThrottling: false,
		},
	};
}

function overlayIsLoaded(win: BrowserWindow): boolean {
	if (win.webContents.isDestroyed() || win.webContents.isLoading()) return false;
	return win.webContents.getURL().includes("screenshot-overlay");
}

function loadOverlay(win: BrowserWindow): void {
	if (overlayIsLoaded(win)) return;
	const devServer = process.env.ELECTRON_RENDERER_URL;
	if (devServer) {
		void win.loadURL(`${devServer.replace(/\/$/, "")}/screenshot-overlay.html`);
		return;
	}
	void win.loadFile(join(import.meta.dirname, "../renderer/screenshot-overlay.html"));
}

function decorateOverlay(win: BrowserWindow): void {
	win.setAlwaysOnTop(true, "screen-saver");
	win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
}

function createOverlayWindow(bounds: Electron.Rectangle): BrowserWindow {
	const win = markScreenshotWindow(new BrowserWindow(overlayBounds(bounds)));
	decorateOverlay(win);
	// Windows excludes this surface from capture; macOS applies NSWindowSharingNone for capture
	// implementations that still honor it. ScreenCaptureKit can bypass the macOS flag, so capture is
	// still requested before this window is shown rather than relying on protection alone.
	if (process.platform === "win32" || process.platform === "darwin") win.setContentProtection(true);
	const webContentsId = win.webContents.id;
	win.webContents.on("did-start-navigation", () => screenshotRendererGate.markLoading(webContentsId));
	win.webContents.on("before-input-event", (event, input) => {
		if (input.type !== "keyDown" || input.key !== "Escape") return;
		event.preventDefault();
		closeScreenshotOverlay({ foreground: false });
	});
	win.on("closed", () => {
		screenshotRendererGate.forget(webContentsId);
	});
	loadOverlay(win);
	return win;
}

/**
 * Hidden overlay, already loaded, so the shortcut does not wait on Chromium creating a window.
 */
export function prewarmScreenshotOverlay(): void {
	if (prewarmedOverlay && !prewarmedOverlay.isDestroyed()) return;
	const primary = screen.getPrimaryDisplay();
	const win = createOverlayWindow(primary.bounds);
	win.on("closed", () => {
		if (prewarmedOverlay === win) prewarmedOverlay = null;
	});
	prewarmedOverlay = win;
}

function takeOverlayWindow(bounds: Electron.Rectangle): BrowserWindow {
	if (prewarmedOverlay && !prewarmedOverlay.isDestroyed()) {
		const win = prewarmedOverlay;
		prewarmedOverlay = null;
		win.setBounds(bounds);
		return win;
	}
	return createOverlayWindow(bounds);
}

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
let escapeShortcutRegistered = false;
let currentSettingsProvider: (() => Settings | undefined) | null = null;

function hasActiveScreenshotOverlay(): boolean {
	return overlayWindows.some((window) => !window.isDestroyed());
}

function registerScreenshotEscape(): void {
	if (escapeShortcutRegistered || activeShortcut?.toLowerCase() === "escape") return;
	try {
		escapeShortcutRegistered = globalShortcut.register("Escape", () => {
			closeScreenshotOverlay({ foreground: false });
		});
		if (!escapeShortcutRegistered) {
			console.warn("[screenshot] failed to register Escape while the no-activate overlay is open");
		}
	} catch (error) {
		console.warn("[screenshot] failed to register Escape while the no-activate overlay is open", error);
	}
}

function unregisterScreenshotEscape(): void {
	if (!escapeShortcutRegistered) return;
	try {
		globalShortcut.unregister("Escape");
	} finally {
		escapeShortcutRegistered = false;
	}
}

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
 * Check whether a shortcut accelerator is available and valid in the current OS.
 */
export function checkShortcutAvailable(shortcut: string): { ok: boolean; error?: string } {
	if (typeof shortcut !== "string") {
		return { ok: false, error: "快捷键格式无效" };
	}
	let normalized = shortcut.trim();
	if (!normalized) return { ok: true };

	normalized = normalized.replace(/Option/gi, "Alt");
	normalized = normalized.replace(/Command\+/gi, "CommandOrControl+");

	if (activeShortcut && activeShortcut.toLowerCase() === normalized.toLowerCase()) {
		return { ok: true };
	}

	try {
		// 检查系统全局热键是否已被占用
		const isRegistered = globalShortcut.isRegistered(normalized);
		if (isRegistered) {
			return { ok: false, error: "该快捷键已被系统或其他应用（如微信）占用" };
		}
		const success = globalShortcut.register(normalized, () => {});
		if (!success) {
			return { ok: false, error: "该快捷键已被微信等其他应用程序占用，无法绑定" };
		}
		globalShortcut.unregister(normalized);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : "快捷键格式不合法" };
	}
}

/** Remember renderer readiness even when a prewarmed overlay reports it before capture starts. */
export function revealScreenshotOverlay(webContentsId: number): void {
	screenshotRendererGate.markReady(webContentsId);
}

/**
 * Close and destroy all active overlay windows, restoring the foreground only when appropriate.
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
export function closeScreenshotOverlay(options?: { restoreFocus?: boolean; foreground?: boolean; prewarm?: boolean }): void {
	unregisterScreenshotEscape();
	const activeOverlays = overlayWindows;
	const previousPrewarm = prewarmedOverlay;
	/*
	 * Resolve the application window before creating the next prewarm.
	 *
	 * A prewarmed overlay is a BrowserWindow too. Creating it first made this search select that
	 * hidden capture window as the "main" window and show it after Escape or Finish. With no init data,
	 * it painted the shell background, kept the crosshair, and could never export a selection.
	 */
	const main = findScreenshotReturnWindow(BrowserWindow.getAllWindows(), activeOverlays, previousPrewarm);

	for (const win of overlayWindows) {
		if (!win.isDestroyed()) {
			win.destroy();
		}
	}
	overlayWindows = [];

	if (options?.prewarm !== false) prewarmScreenshotOverlay();

	// Not when another overlay is about to take its place — see the call in
	// `startScreenshotSession`. Raising the app for one frame between two overlays is a flicker.
	if (options?.restoreFocus === false) return;
	if (!main) return;
	if (main.isMinimized()) main.restore();

	/*
	 * Raised within Lyra either way, so it is never buried under its own overlay's leftovers — but
	 * `showInactive`, which does not take the foreground from whatever the user is actually looking
	 * at.
	 *
	 * Two things have to be true at once and they pull in opposite directions. A finished capture
	 * has produced something that is going to Lyra, so Lyra comes forward. A *cancelled* one has
	 * produced nothing: pressing Escape is how you say "never mind", and answering that by throwing
	 * the whole application in front of whatever the user was reading is the opposite of never
	 * mind. Same for a capture the global shortcut started from another app — see `cameFromApp`.
	 */
	if (!(options?.foreground ?? cameFromApp)) {
		main.showInactive();
		/*
		 * `app.hide()` is how a macOS application steps back: the window is not closed and nothing
		 * is lost, the frontmost slot returns to whatever had it, and the dock icon brings Lyra back
		 * exactly as it was. Only when the capture did not come from Lyra in the first place —
		 * hiding an app the user is actually looking at would be its own rudeness.
		 */
		if (process.platform === "darwin" && !cameFromApp) app.hide();
		return;
	}
	main.show();
	main.focus();
	// The application, not just the window — see above.
	app.focus({ steal: true });
}

/**
 * Open the interactive fullscreen overlay on the display under the cursor.
 *
 * Capture starts before the overlay is shown. On Windows the no-activate overlay is excluded from
 * capture, so its cursor and later selection UI cannot race into the saved pixels.
 */
export async function startScreenshotSession(customSettings?: ScreenshotSettings): Promise<void> {
	/*
	 * Asked before the overlay is shown. The overlay is non-focusable, but resolving intent before
	 * changing any window state keeps this independent of platform-specific foreground behaviour.
	 */
	cameFromApp = BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isFocused());

	// A leftover overlay from a previous session, cleared without handing the foreground back —
	// this one is about to take its place. Do not prewarm: we are about to take that window.
	closeScreenshotOverlay({ restoreFocus: false, prewarm: false });

	const cursorPoint = screen.getCursorScreenPoint();
	const currentDisplay = screen.getDisplayNearestPoint(cursorPoint);
	const { bounds } = currentDisplay;
	const scaleFactor = currentDisplay.scaleFactor || 1;
	const settings = customSettings ?? currentSettingsProvider?.()?.screenshot;
	/*
	 * Start capture first, then reveal as soon as the prewarmed renderer is ready. Windows content
	 * protection excludes this window if those operations overlap; other platforms still get the
	 * earliest possible capture request without delaying the crosshair on capture completion.
	 */
	const snapshotPromise = captureFullDisplaySnapshot(currentDisplay.id);

	const win = takeOverlayWindow(bounds);
	overlayWindows.push(win);
	registerScreenshotEscape();
	win.on("closed", () => {
		overlayWindows = overlayWindows.filter((w) => w !== win);
	});

	const base = { bounds, scaleFactor, settings };
	let rendererReady = false;
	let snapshotDataUrl: string | null = null;
	let detectedWindows: Awaited<ReturnType<typeof detectVisibleWindows>> | undefined;
	let initialized = false;
	let revealed = false;
	const webContentsId = win.webContents.id;

	const reveal = () => {
		if (revealed || !rendererReady || win.isDestroyed() || win.webContents.isDestroyed()) return;
		// Showing without activation leaves the user's current application directly underneath.
		win.showInactive();
		revealed = true;
	};
	const initialize = () => {
		if (initialized || !rendererReady || !snapshotDataUrl || win.isDestroyed() || win.webContents.isDestroyed()) return;
		initialized = true;
		win.webContents.send("screenshot:init", { ...base, snapshot: snapshotDataUrl, windows: detectedWindows });
	};
	screenshotRendererGate.whenReady(webContentsId, () => {
		rendererReady = true;
		reveal();
		initialize();
	});

	let excludeHwnd: bigint | undefined;
	try {
		excludeHwnd = hwndFromNativeHandle(win.getNativeWindowHandle());
	} catch {
		excludeHwnd = undefined;
	}

	void detectVisibleWindows({ excludeHwnd, excludeBounds: bounds }).then((windows) => {
		detectedWindows = windows;
		if (initialized && !win.isDestroyed() && !win.webContents.isDestroyed()) {
			win.webContents.send("screenshot:init", { ...base, snapshot: "", windows });
		}
	});

	const snapshot = await snapshotPromise;
	if (win.isDestroyed() || win.webContents.isDestroyed()) return;
	if (!snapshot) {
		closeScreenshotOverlay({ restoreFocus: false });
		return;
	}
	snapshotDataUrl = snapshot.dataUrl;
	initialize();
}

/**
 * Handle save/finish from overlay renderer
 */
export async function finishScreenshot(dataUrl: string, settings?: ScreenshotSettings): Promise<{ ok: boolean; filePath?: string }> {
	closeScreenshotOverlay({ prewarm: false });

	// Broadcast before prewarming so a hidden overlay never receives the completed screenshot.
	for (const w of BrowserWindow.getAllWindows()) {
		if (!w.isDestroyed() && !w.webContents.isDestroyed()) {
			w.webContents.send("screenshot:captured", dataUrl);
		}
	}
	prewarmScreenshotOverlay();

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
export function registerScreenshotShortcut(getSettings: () => Settings | undefined): void {
	// No platform gate: `globalShortcut` and the capture behind it work on all three. This used to
	// return early anywhere but macOS, which left the shortcut unregistered and the setting for it
	// on screen — a key combination the settings page offered to change and nothing would answer.
	currentSettingsProvider = getSettings;

	let shortcut = getSettings()?.screenshot?.shortcut?.trim();
	if (shortcut) {
		shortcut = shortcut.replace(/Option/gi, "Alt");
		// Normalize "Command+" to "CommandOrControl+" if specified
		shortcut = shortcut.replace(/Command\+/gi, "CommandOrControl+");
		// Windows specific: map "Control" or standard syntax
		if (process.platform === "win32") {
			// e.g. If Alt+A is occupied by other apps (like WeChat/QQ), allow clean retry
		}
	}

	if (activeShortcut) {
		try {
			globalShortcut.unregister(activeShortcut);
		} catch {}
		activeShortcut = null;
	}

	if (!shortcut) return;

	try {
		// If user configured a shortcut that is used by external software (like WeChat Alt+A),
		// let OS trigger it naturally while we handle trigger when available.
		const success = globalShortcut.register(shortcut, () => {
			if (hasActiveScreenshotOverlay()) {
				closeScreenshotOverlay({ foreground: false });
				return;
			}
			void startScreenshotSession();
		});
		if (success) {
			activeShortcut = shortcut;
		}
	} catch (err) {
		console.warn(`[screenshot] 快捷键格式错误: ${shortcut}`, err);
	}
}

export function unregisterScreenshotShortcut(): void {
	unregisterScreenshotEscape();
	if (activeShortcut) {
		try {
			globalShortcut.unregister(activeShortcut);
		} catch {}
		activeShortcut = null;
	}
}
