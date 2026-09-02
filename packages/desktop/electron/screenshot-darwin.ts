/**
 * Screenshot driver for macOS.
 *
 * Implements upstream 0.8.34's dedicated macOS pipeline:
 * - Direct ScreenCaptureKit / desktopCapturer pipeline with BGRA -> RGBA bitmap swap
 * - Persistent single overlay window with prewarmed presentation surface
 * - Strict multi-space and Dock protection (skipTransformProcessType)
 * - Safe app.hide() & focus restoration order
 */

import { join } from "node:path";
import { app, BrowserWindow, desktopCapturer, globalShortcut, screen, systemPreferences } from "electron";
import type { ScreenshotSettings } from "@lyra/core";
import { listDarwinWindows } from "./screenshot-darwin-windows.ts";

let overlay: BrowserWindow | null = null;
let overlayLoading: Promise<BrowserWindow> | null = null;
let failsafeTimer: NodeJS.Timeout | null = null;
let awaitingPaint: BrowserWindow | null = null;
let paintFallback: NodeJS.Timeout | null = null;
let warmingPresentation: NodeJS.Timeout | null = null;
let steppedAsideMain: BrowserWindow | null = null;
let cameFromApp = false;
let sessionCount = 0;
let captureActive = false;
let escapeGuard = false;

const revealers = new Map<number, () => void>();

function clearFailsafe(): void {
	if (failsafeTimer) clearTimeout(failsafeTimer);
	failsafeTimer = null;
	if (paintFallback) clearTimeout(paintFallback);
	paintFallback = null;
	awaitingPaint = null;
}

function holdEscape(on: boolean): void {
	if (on === escapeGuard) return;
	try {
		if (on) escapeGuard = globalShortcut.register("Escape", () => closeDarwinScreenshot({ foreground: false }));
		else {
			globalShortcut.unregister("Escape");
			escapeGuard = false;
		}
	} catch {
		escapeGuard = false;
	}
}

function releaseSteppedAsideMain(): BrowserWindow | null {
	const main = steppedAsideMain;
	steppedAsideMain = null;
	if (!main || main.isDestroyed()) return null;
	return main;
}

function settleOverlayHidden(): void {
	setTimeout(() => {
		const win = overlay;
		if (!win || win.isDestroyed()) return;
		win.hide();
		win.setIgnoreMouseEvents(true);
		if (!win.webContents.isDestroyed()) win.webContents.send("screenshot:hidden");
	}, 250);
}

function stepMainAside(overlayWindow: BrowserWindow): void {
	if (cameFromApp || steppedAsideMain) return;
	const main = BrowserWindow.getAllWindows().find(
		(other) => other !== overlayWindow && !other.isDestroyed() && other.isVisible(),
	);
	if (!main) return;
	main.hide();
	steppedAsideMain = main;
	if (!overlayWindow.isDestroyed()) overlayWindow.focus();
}

export function overlayPaintedDarwin(): void {
	if (paintFallback) {
		clearTimeout(paintFallback);
		paintFallback = null;
	}
	const win = awaitingPaint;
	awaitingPaint = null;
	if (!win || win.isDestroyed() || !win.isVisible()) return;
	win.setOpacity(1);
	stepMainAside(win);
}

function ensureDarwinOverlay(): Promise<BrowserWindow> {
	if (overlay && !overlay.isDestroyed()) return Promise.resolve(overlay);
	if (overlayLoading) return overlayLoading;

	const bounds = screen.getPrimaryDisplay().bounds;
	const win = new BrowserWindow({
		x: bounds.x,
		y: bounds.y,
		width: bounds.width,
		height: bounds.height,
		frame: false,
		transparent: true,
		show: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		resizable: false,
		movable: false,
		fullscreenable: false,
		hasShadow: false,
		acceptFirstMouse: true,
		backgroundColor: "#00000000",
		enableLargerThanScreen: true,
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/screenshot.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			backgroundThrottling: false,
		},
	});

	win.setAlwaysOnTop(true, "screen-saver");
	win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
	win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });

	win.on("closed", () => {
		if (overlay === win) overlay = null;
		overlayLoading = null;
		revealers.delete(win.webContents.id);
	});

	const devServer = process.env.ELECTRON_RENDERER_URL;
	const load = devServer
		? win.loadURL(`${devServer.replace(/\/$/, "")}/screenshot-overlay.html`)
		: win.loadFile(join(import.meta.dirname, "../renderer/screenshot-overlay.html"));

	overlayLoading = new Promise<BrowserWindow>((resolve, reject) => {
		win.webContents.once("did-finish-load", () => {
			overlay = win;
			resolve(win);
		});
		load.catch((err: unknown) => {
			overlayLoading = null;
			if (!win.isDestroyed()) win.destroy();
			reject(err instanceof Error ? err : new Error(String(err)));
		});
	});
	return overlayLoading;
}

function warmFirstPresentation(win: BrowserWindow): void {
	if (win.isDestroyed() || win.isVisible()) return;
	win.setOpacity(0);
	win.setIgnoreMouseEvents(true);
	win.showInactive();
	warmingPresentation = setTimeout(() => {
		warmingPresentation = null;
		if (win.isDestroyed()) return;
		win.hide();
		win.setOpacity(1);
	}, 220);
}

function endWarmPresentation(): void {
	if (!warmingPresentation) return;
	clearTimeout(warmingPresentation);
	warmingPresentation = null;
	if (!overlay || overlay.isDestroyed()) return;
	overlay.hide();
	overlay.setOpacity(1);
}

export function prewarmDarwinScreenshot(): void {
	ensureDarwinOverlay().then(warmFirstPresentation).catch(() => {});
}

async function captureDarwinSnapshot(displayId?: number): Promise<{ pixels: Uint8Array; width: number; height: number; scaleFactor: number } | null> {
	const targetDisplay = displayId !== undefined
		? screen.getAllDisplays().find((d) => d.id === displayId) ?? screen.getPrimaryDisplay()
		: screen.getPrimaryDisplay();
	const scaleFactor = targetDisplay.scaleFactor || 1;

	if (systemPreferences.getMediaAccessStatus("screen") !== "granted") {
		await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => []);
		return null;
	}

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
			const b = pixels[i]!;
			pixels[i] = pixels[i + 2]!;
			pixels[i + 2] = b;
		}

		return { pixels, width: size.width, height: size.height, scaleFactor };
	} catch (err) {
		console.error("[screenshot] macOS captureDisplay error:", err);
		return null;
	}
}

export function revealDarwinScreenshotOverlay(webContentsId: number): void {
	const reveal = revealers.get(webContentsId);
	if (!reveal) return;
	revealers.delete(webContentsId);
	reveal();
}

export function closeDarwinScreenshot(options?: { restoreFocus?: boolean; foreground?: boolean }): void {
	const cover = overlay && !overlay.isDestroyed() && overlay.isVisible() ? overlay : null;
	captureActive = false;
	holdEscape(false);
	clearFailsafe();
	if (overlay && !overlay.isDestroyed()) revealers.delete(overlay.webContents.id);
	const steppedAside = releaseSteppedAsideMain();
	if (!cover) return;

	const stepBack = options?.restoreFocus !== false && !(options?.foreground ?? cameFromApp) && !cameFromApp;
	if (stepBack) {
		app.hide();
		settleOverlayHidden();
		return;
	}

	if (options?.restoreFocus === false) return;

	const main = steppedAside ?? BrowserWindow.getAllWindows().find((win) => win !== cover && !win.isDestroyed());
	if (!(options?.foreground ?? cameFromApp)) {
		cover.hide();
		settleOverlayHidden();
		return;
	}

	if (main) {
		if (main.isMinimized()) main.restore();
		main.show();
		main.focus();
		app.focus({ steal: true });
	}
	cover.hide();
	settleOverlayHidden();
}

export async function startDarwinScreenshot(settings?: ScreenshotSettings): Promise<void> {
	cameFromApp = BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isFocused());
	endWarmPresentation();
	closeDarwinScreenshot({ restoreFocus: false });

	const cursorPoint = screen.getCursorScreenPoint();
	const currentDisplay = screen.getDisplayNearestPoint(cursorPoint);
	const { bounds } = currentDisplay;

	const [snapshot, windows, win] = await Promise.all([
		captureDarwinSnapshot(currentDisplay.id),
		listDarwinWindows(bounds),
		ensureDarwinOverlay(),
	]);

	if (!snapshot || win.isDestroyed()) return;
	captureActive = true;

	win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
	win.setIgnoreMouseEvents(false);
	win.setOpacity(1);

	const reveal = () => {
		clearFailsafe();
		if (win.isDestroyed()) return;
		if (win.isVisible()) {
			holdEscape(true);
			win.focus();
			if (!win.webContents.isDestroyed()) win.webContents.send("screenshot:shown");
			return;
		}

		win.setOpacity(0);
		win.showInactive();
		holdEscape(true);
		awaitingPaint = win;
		paintFallback = setTimeout(() => {
			paintFallback = null;
			overlayPaintedDarwin();
		}, 250);
		setTimeout(() => {
			if (win.isDestroyed()) return;
			win.focus();
		}, 32);
		if (!win.webContents.isDestroyed()) win.webContents.send("screenshot:shown");
	};

	revealers.set(win.webContents.id, reveal);
	failsafeTimer = setTimeout(reveal, 1500);

	if (win.webContents.isDestroyed()) {
		captureActive = false;
		return;
	}

	const snappableWindows = windows.map((w, idx) => ({
		id: idx + 1,
		title: w.app,
		x: w.x + bounds.x,
		y: w.y + bounds.y,
		width: w.width,
		height: w.height,
	}));

	win.webContents.send("screenshot:init", {
		snapshot: { pixels: snapshot.pixels, width: snapshot.width, height: snapshot.height },
		session: ++sessionCount,
		bounds,
		windows: snappableWindows,
		scaleFactor: snapshot.scaleFactor,
		settings,
		renderMode: "snapshot",
	});
}

export function hasActiveDarwinScreenshot(): boolean {
	return captureActive || (overlay !== null && !overlay.isDestroyed() && overlay.isVisible());
}
