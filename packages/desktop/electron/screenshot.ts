/**
 * Screenshot Coordinator: unified multi-platform screenshot orchestrator.
 *
 * Dispatches platform-specific capture pipelines:
 * - Win32: Live transparent cutout + Win32 Koffi Z-order window snapping.
 * - Darwin: ScreenCaptureKit/desktopCapturer raw BGRA-RGBA swap, persistent surface, and macOS Dock protection.
 *
 * Manages cross-platform lifecycle: global shortcut registration, clipboard writing,
 * file saving, and composer IPC broadcasting.
 */

import { join } from "node:path";
import { BrowserWindow, clipboard, globalShortcut, nativeImage } from "electron";
import type { ScreenshotSettings, Settings } from "@lyra/core";

import { resolveSaveDirectory } from "./screenshot-path.ts";
import {
	closeWin32Screenshot,
	hasActiveWin32Screenshot,
	overlayPaintedWin32,
	prewarmWin32Screenshot,
	revealWin32ScreenshotOverlay,
	startWin32Screenshot,
} from "./screenshot-win32.ts";
import {
	closeDarwinScreenshot,
	hasActiveDarwinScreenshot,
	overlayPaintedDarwin,
	prewarmDarwinScreenshot,
	revealDarwinScreenshotOverlay,
	startDarwinScreenshot,
} from "./screenshot-darwin.ts";

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

export function hasActiveScreenshotOverlay(): boolean {
	if (process.platform === "win32") return hasActiveWin32Screenshot();
	return hasActiveDarwinScreenshot();
}

export function prewarmScreenshotOverlay(): void {
	if (process.platform === "win32") {
		prewarmWin32Screenshot();
	} else if (process.platform === "darwin") {
		prewarmDarwinScreenshot();
	}
}

export function warmScreenshotOverlay(): void {
	prewarmScreenshotOverlay();
}

export function isScreenshotOverlay(_win: BrowserWindow): boolean {
	return false;
}

export function destroyScreenshotOverlay(): void {
	closeScreenshotOverlay();
}

export function dismissStrayOverlay(): void {
	// Handled internally by platform-specific overlays
}

export function revealScreenshotOverlay(webContentsId: number): void {
	if (process.platform === "win32") {
		revealWin32ScreenshotOverlay(webContentsId);
	} else {
		revealDarwinScreenshotOverlay(webContentsId);
	}
}

export function overlayPainted(): void {
	if (process.platform === "darwin") {
		overlayPaintedDarwin();
	} else if (process.platform === "win32") {
		overlayPaintedWin32();
	}
}

export function closeScreenshotOverlay(options?: { restoreFocus?: boolean; foreground?: boolean; prewarm?: boolean }): void {
	if (process.platform === "win32") {
		closeWin32Screenshot(options);
	} else {
		closeDarwinScreenshot(options);
	}
}

export async function startScreenshotSession(customSettings?: ScreenshotSettings): Promise<void> {
	const settings = customSettings ?? currentSettingsProvider?.()?.screenshot;
	if (process.platform === "win32") {
		await startWin32Screenshot(settings);
	} else {
		await startDarwinScreenshot(settings);
	}
}

export async function finishScreenshot(dataUrl: string, settings?: ScreenshotSettings): Promise<{ ok: boolean; filePath?: string }> {
	closeScreenshotOverlay({ prewarm: false });

	const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
	const buffer = Buffer.from(base64Data, "base64");
	const image = nativeImage.createFromBuffer(buffer);

	// Write directly to clipboard as an image
	clipboard.writeImage(image);

	// Broadcast captured event to all renderer windows so active session composer receives it
	for (const w of BrowserWindow.getAllWindows()) {
		if (!w.isDestroyed() && !w.webContents.isDestroyed()) {
			w.webContents.send("screenshot:captured", dataUrl);
		}
	}

	prewarmScreenshotOverlay();

	// Auto-save if enabled
	const resolvedSettings = settings ?? currentSettingsProvider?.()?.screenshot;
	if (resolvedSettings?.autoSave) {
		try {
			const saveDir = await resolveSaveDirectory(resolvedSettings.saveDirectory ?? resolvedSettings.saveLocation);
			const filename = generateScreenshotFilename();
			const filePath = join(saveDir, filename);
			const fs = await import("node:fs/promises");
			await fs.writeFile(filePath, buffer);
			return { ok: true, filePath };
		} catch (err) {
			console.error("[screenshot] 自动保存截图失败:", err);
			return { ok: false };
		}
	}

	return { ok: true };
}

export function registerScreenshotShortcut(
	getSettings: () => Settings | undefined,
	onTriggered?: () => void,
): void {
	currentSettingsProvider = getSettings;
	if (onTriggered) onCaptureTriggered = onTriggered;
	const settings = getSettings();
	let shortcut = settings?.screenshot?.shortcut ?? "CommandOrControl+Shift+X";

	if (process.platform !== "darwin") {
		shortcut = shortcut.replace(/CmdOrCtrl+/gi, "CommandOrControl+");
		shortcut = shortcut.replace(/Command+/gi, "CommandOrControl+");
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
			if (hasActiveScreenshotOverlay()) {
				closeScreenshotOverlay({ foreground: false });
				return;
			}
			startScreenshotSession().catch((err: unknown) => {
				console.error("[screenshot] 快捷键触发的截图失败:", err);
			});
			onCaptureTriggered?.();
		});
		if (success) {
			activeShortcut = shortcut;
		}
	} catch (err) {
		console.warn(`[screenshot] 快捷键格式错误: ${shortcut}`, err);
	}
}

export function overlayPassedThrough(): void {
	// Let clicks through on macOS if overlay is active
}

export function checkShortcutAvailable(shortcut: string): { ok: boolean; error?: string } {
	if (!shortcut.trim()) return { ok: false, error: "Shortcut cannot be empty" };
	return { ok: true };
}

export function unregisterScreenshotShortcut(): void {
	if (activeShortcut) {
		try {
			globalShortcut.unregister(activeShortcut);
		} catch {}
		activeShortcut = null;
	}
}
