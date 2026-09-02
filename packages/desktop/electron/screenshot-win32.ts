/**
 * Screenshot driver for Windows (Win32).
 *
 * Implements local proprietary industrial-grade capabilities:
 * - Live transparent cutout architecture with SVG punch-hole
 * - Win32 native window tree sniffing and Z-order hit-testing via koffi
 * - Zero-latency prewarmed frameless transparent window
 * - Excludes capture surface from system recording
 */

import { join } from "node:path";
import { app, BrowserWindow, desktopCapturer, globalShortcut, screen } from "electron";
import type { ScreenshotSettings } from "@lyra/core";
import { findScreenshotReturnWindow, markScreenshotWindow, ScreenshotRendererGate } from "./screenshot-window.ts";
import { detectVisibleWindows, hwndFromNativeHandle } from "./window-detect.ts";

let overlayWindows: BrowserWindow[] = [];
let prewarmedOverlay: BrowserWindow | null = null;
const screenshotRendererGate = new ScreenshotRendererGate();

let cameFromApp = false;
let screenshotSessionId = 0;
let escapeShortcutRegistered = false;

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
		skipTaskbar: true,
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
	if (process.platform === "win32") win.setContentProtection(true);
	const webContentsId = win.webContents.id;
	win.webContents.on("did-start-navigation", () => screenshotRendererGate.markLoading(webContentsId));
	win.webContents.on("before-input-event", (event, input) => {
		if (input.type !== "keyDown" || input.key !== "Escape") return;
		event.preventDefault();
		closeWin32Screenshot({ foreground: false });
	});
	win.on("closed", () => {
		screenshotRendererGate.forget(webContentsId);
	});
	loadOverlay(win);
	return win;
}

export function prewarmWin32Screenshot(): void {
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

function registerScreenshotEscape(): void {
	if (escapeShortcutRegistered) return;
	try {
		escapeShortcutRegistered = globalShortcut.register("Escape", () => {
			closeWin32Screenshot({ foreground: false });
		});
	} catch (error) {
		console.warn("[screenshot] failed to register Escape on Windows", error);
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

async function captureWin32Snapshot(displayId?: number): Promise<{ pixels: Uint8Array; width: number; height: number; scaleFactor: number } | null> {
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
		if (sources.length === 0) return null;

		const source = sources.find((candidate) => candidate.display_id === String(targetDisplay.id)) ?? sources[0];
		const image = source.thumbnail;
		if (image.isEmpty()) return null;

		const size = image.getSize();
		const pixels = image.toBitmap();
		for (let i = 0; i < pixels.length; i += 4) {
			const blue = pixels[i]!;
			pixels[i] = pixels[i + 2]!;
			pixels[i + 2] = blue;
		}
		return { pixels, width: size.width, height: size.height, scaleFactor };
	} catch (err) {
		console.error("[screenshot] Win32 display snapshot failed:", err);
		return null;
	}
}

export function revealWin32ScreenshotOverlay(webContentsId: number): void {
	screenshotRendererGate.markReady(webContentsId);
}

export function closeWin32Screenshot(options?: { restoreFocus?: boolean; foreground?: boolean; prewarm?: boolean }): void {
	unregisterScreenshotEscape();
	const activeOverlays = overlayWindows;
	const previousPrewarm = prewarmedOverlay;
	const main = findScreenshotReturnWindow(BrowserWindow.getAllWindows(), activeOverlays, previousPrewarm);

	for (const win of overlayWindows) {
		if (!win.isDestroyed()) {
			win.destroy();
		}
	}
	overlayWindows = [];

	if (options?.prewarm !== false) prewarmWin32Screenshot();

	if (options?.restoreFocus === false) return;
	if (!main) return;
	if (main.isMinimized()) main.restore();

	if (!(options?.foreground ?? cameFromApp)) {
		main.showInactive();
		return;
	}
	main.show();
	main.focus();
	app.focus({ steal: true });
}

export async function startWin32Screenshot(settings?: ScreenshotSettings): Promise<void> {
	cameFromApp = BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isFocused());

	closeWin32Screenshot({ restoreFocus: false, prewarm: false });

	const cursorPoint = screen.getCursorScreenPoint();
	const currentDisplay = screen.getDisplayNearestPoint(cursorPoint);
	const { bounds } = currentDisplay;
	const scaleFactor = currentDisplay.scaleFactor || 1;
	const session = ++screenshotSessionId;

	const snapshotPromise = captureWin32Snapshot(currentDisplay.id);

	const win = takeOverlayWindow(bounds);
	overlayWindows.push(win);
	registerScreenshotEscape();
	win.on("closed", () => {
		overlayWindows = overlayWindows.filter((w) => w !== win);
	});

	const base = { bounds, scaleFactor, settings, session, renderMode: "live" };
	let rendererReady = false;
	let snapshotData: { pixels: Uint8Array; width: number; height: number } | null = null;
	let detectedWindows: Awaited<ReturnType<typeof detectVisibleWindows>> | undefined;
	let revealed = false;
	const webContentsId = win.webContents.id;

	const sendState = () => {
		if (!rendererReady || win.isDestroyed() || win.webContents.isDestroyed()) return;
		win.webContents.send("screenshot:init", { ...base, snapshot: snapshotData, windows: detectedWindows });
	};
	const reveal = () => {
		if (revealed || !rendererReady || win.isDestroyed() || win.webContents.isDestroyed()) return;
		win.showInactive();
		revealed = true;
	};
	screenshotRendererGate.whenReady(webContentsId, () => {
		rendererReady = true;
		sendState();
		reveal();
	});

	let excludeHwnd: bigint | undefined;
	try {
		excludeHwnd = hwndFromNativeHandle(win.getNativeWindowHandle());
	} catch {
		excludeHwnd = undefined;
	}

	void detectVisibleWindows({ excludeHwnd, excludeBounds: bounds }).then((windows) => {
		detectedWindows = windows;
		sendState();
	});

	const snapshot = await snapshotPromise;
	if (win.isDestroyed() || win.webContents.isDestroyed()) return;
	if (!snapshot) {
		closeWin32Screenshot({ restoreFocus: false });
		return;
	}
	snapshotData = { pixels: snapshot.pixels, width: snapshot.width, height: snapshot.height };
	sendState();
}

export function hasActiveWin32Screenshot(): boolean {
	return overlayWindows.some((window) => !window.isDestroyed());
}
