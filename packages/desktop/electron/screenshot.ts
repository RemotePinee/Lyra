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
 * Close and destroy all active overlay windows.
 */
export function closeScreenshotOverlay(): void {
	for (const win of overlayWindows) {
		if (!win.isDestroyed()) {
			win.destroy();
		}
	}
	overlayWindows = [];
}

/**
 * Open the interactive fullscreen overlay window on the display where the cursor currently is.
 */
export async function startScreenshotSession(customSettings?: ScreenshotSettings): Promise<void> {
	closeScreenshotOverlay();

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

	win.webContents.once("did-finish-load", () => {
		win.webContents.send("screenshot:init", {
			snapshot: snapshot.dataUrl,
			bounds,
			scaleFactor: snapshot.scaleFactor,
			settings: customSettings ?? currentSettingsProvider?.()?.screenshot,
		});
		win.show();
		win.focus();
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
