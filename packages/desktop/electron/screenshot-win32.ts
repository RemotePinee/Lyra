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
import { coverDisplay, findScreenshotReturnWindow, markScreenshotWindow, ScreenshotRendererGate } from "./screenshot-window.ts";
import { detectVisibleWindows, hwndFromNativeHandle } from "./window-detect.ts";
import {
	HWND_BOTTOM,
	HWND_TOPMOST,
	SWP_NOACTIVATE,
	SWP_SHOWWINDOW,
	win32CaptureDisplay,
	win32CoverDisplayPhysical,
	win32RestoreArrowCursor,
	win32SetForegroundWindow,
	win32SetWindowPos,
} from "./window-detect-win32.ts";

let residentOverlay: BrowserWindow | null = null;
let isCapturingActive = false;
const screenshotRendererGate = new ScreenshotRendererGate();

let cameFromApp = false;
let screenshotSessionId = 0;
let escapeShortcutRegistered = false;

function getOffscreenBounds(): Electron.Rectangle {
	const primary = screen.getPrimaryDisplay();
	return {
		x: -32000,
		y: -32000,
		width: primary.bounds.width,
		height: primary.bounds.height,
	};
}

function overlayBounds(bounds: Electron.Rectangle): Electron.BrowserWindowConstructorOptions {
	return {
		x: bounds.x,
		y: bounds.y,
		width: bounds.width,
		height: bounds.height,
		frame: false,
		transparent: true,
		show: true,
		focusable: true,
		thickFrame: false,
		roundedCorners: false,
		acceptFirstMouse: true,
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

function createResidentOverlay(): BrowserWindow {
	const offscreen = getOffscreenBounds();
	const win = markScreenshotWindow(new BrowserWindow(overlayBounds(offscreen)));
	win.setIgnoreMouseEvents(true);
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
		if (residentOverlay === win) {
			residentOverlay = null;
			isCapturingActive = false;
			setTimeout(() => prewarmWin32Screenshot(), 200);
		}
	});
	loadOverlay(win);
	return win;
}

export function prewarmWin32Screenshot(): void {
	if (residentOverlay && !residentOverlay.isDestroyed()) return;
	residentOverlay = createResidentOverlay();
	// Warm up koffi FFI bindings, DWM frame sniffing, and GDI capture pipeline offscreen
	void detectVisibleWindows();
	try {
		const primary = screen.getPrimaryDisplay();
		if (primary) void win32CaptureDisplay(primary);
	} catch {
		// Ignore any display capture failure during initial silent prewarm
	}
}

function ensureResidentOverlay(): BrowserWindow {
	if (residentOverlay && !residentOverlay.isDestroyed()) {
		return residentOverlay;
	}
	residentOverlay = createResidentOverlay();
	return residentOverlay;
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

async function captureWin32Snapshot(display: Electron.Display): Promise<{ pixels: Uint8Array; width: number; height: number; scaleFactor: number } | null> {
	// First attempt 1:1 hardware pixel capture via Win32 GDI BitBlt (approx 20ms, zero distortion)
	try {
		const gdi = win32CaptureDisplay(display);
		if (gdi && gdi.pixels.length > 0) return gdi;
	} catch (err) {
		console.warn("[screenshot] Win32 GDI fast capture failed, falling back to desktopCapturer:", err);
	}

	const scaleFactor = display.scaleFactor || 1;
	try {
		const sources = await desktopCapturer.getSources({
			types: ["screen"],
			thumbnailSize: {
				width: Math.round(display.bounds.width * scaleFactor),
				height: Math.round(display.bounds.height * scaleFactor),
			},
			fetchWindowIcons: false,
		});
		if (sources.length === 0) return null;

		const source = sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0];
		if (!source) return null;
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
		console.error("[screenshot] Win32 display snapshot fallback failed:", err);
		return null;
	}
}

let awaitingPaintWin32 = false;
let paintFallbackTimer: ReturnType<typeof setTimeout> | null = null;

export function overlayPaintedWin32(): void {
	if (paintFallbackTimer) {
		clearTimeout(paintFallbackTimer);
		paintFallbackTimer = null;
	}
	if (!awaitingPaintWin32 || !residentOverlay || residentOverlay.isDestroyed()) return;
	awaitingPaintWin32 = false;
	try {
		residentOverlay.setOpacity(1);
		const hwnd = hwndFromNativeHandle(residentOverlay.getNativeWindowHandle());
		if (hwnd) {
			const SWP_NOMOVE_NOSIZE = 0x0001 | 0x0002;
			win32SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE_NOSIZE | SWP_SHOWWINDOW);
			win32SetForegroundWindow(hwnd);
		}
		residentOverlay.show();
		residentOverlay.focus();
	} catch {
		// Ignore any window teardown error
	}
}

export function revealWin32ScreenshotOverlay(webContentsId: number): void {
	screenshotRendererGate.markReady(webContentsId);
}

export function closeWin32Screenshot(options?: { restoreFocus?: boolean; foreground?: boolean; prewarm?: boolean }): void {
	unregisterScreenshotEscape();
	isCapturingActive = false;
	awaitingPaintWin32 = false;
	if (paintFallbackTimer) {
		clearTimeout(paintFallbackTimer);
		paintFallbackTimer = null;
	}
	win32RestoreArrowCursor();

	const main = findScreenshotReturnWindow(BrowserWindow.getAllWindows(), [], residentOverlay);

	if (residentOverlay && !residentOverlay.isDestroyed()) {
		try {
			residentOverlay.setOpacity(0);
			residentOverlay.webContents.send("screenshot:reset");
			residentOverlay.setIgnoreMouseEvents(true);
			const hwnd = hwndFromNativeHandle(residentOverlay.getNativeWindowHandle());
			const currentSize = residentOverlay.getSize();
			win32SetWindowPos(
				hwnd,
				HWND_BOTTOM,
				-32000,
				-32000,
				currentSize[0] || 1920,
				currentSize[1] || 1080,
				SWP_NOACTIVATE,
			);
		} catch (err) {
			console.warn("[screenshot] failed to park overlay window offscreen:", err);
		}
	}

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

	const cursorPoint = screen.getCursorScreenPoint();
	const currentDisplay = screen.getDisplayNearestPoint(cursorPoint);
	const { bounds } = currentDisplay;
	const session = ++screenshotSessionId;

	const win = ensureResidentOverlay();
	isCapturingActive = true;
	registerScreenshotEscape();

	let hwnd: bigint | undefined;
	try {
		hwnd = hwndFromNativeHandle(win.getNativeWindowHandle());
	} catch {
		hwnd = undefined;
	}

	// 1. Concurrently capture pristine 1:1 screen bitmap and sniff snappable windows BEFORE revealing
	const [snapshot, windows] = await Promise.all([
		captureWin32Snapshot(currentDisplay),
		detectVisibleWindows({ excludeHwnd: hwnd, excludeBounds: bounds }).catch(() => []),
	]);

	if (!snapshot || win.isDestroyed() || session !== screenshotSessionId || !isCapturingActive) {
		closeWin32Screenshot({ restoreFocus: false });
		return;
	}

	const freshCursorPoint = screen.getCursorScreenPoint();
	const cursor = { x: freshCursorPoint.x - bounds.x, y: freshCursorPoint.y - bounds.y };
	const webContentsId = win.webContents.id;

	const snappableWindows = windows.map((w, idx) => ({
		id: idx + 1,
		title: w.title,
		x: w.x,
		y: w.y,
		width: w.width,
		height: w.height,
	}));

	// Send complete initial state in a single atomic dispatch BEFORE showing window so no stale frame appears
	const initPayload = {
		bounds,
		scaleFactor: snapshot.scaleFactor,
		settings,
		session,
		renderMode: "snapshot" as const,
		cursor,
		snapshot: { pixels: snapshot.pixels, width: snapshot.width, height: snapshot.height },
		windows: snappableWindows,
	};

	// 2. Keep window at zero opacity while positioned on target display until first frame is painted
	win.setIgnoreMouseEvents(false);
	win.setOpacity(0);
	coverDisplay(win, bounds);
	try {
		win32CoverDisplayPhysical(win.getNativeWindowHandle(), currentDisplay);
	} catch (err) {
		console.error("[screenshot] failed to set physical display coverage:", err);
	}

	awaitingPaintWin32 = true;
	if (paintFallbackTimer) clearTimeout(paintFallbackTimer);
	// 80ms fallback: reveal window even if renderer paint event was dropped
	paintFallbackTimer = setTimeout(() => {
		overlayPaintedWin32();
	}, 80);

	screenshotRendererGate.whenReady(webContentsId, () => {
		if (win.isDestroyed() || win.webContents.isDestroyed() || !isCapturingActive) return;
		win.webContents.send("screenshot:init", initPayload);
	});
}

export function hasActiveWin32Screenshot(): boolean {
	return isCapturingActive && !!residentOverlay && !residentOverlay.isDestroyed();
}
