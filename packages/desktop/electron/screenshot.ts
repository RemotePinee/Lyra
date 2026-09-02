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
import { app, BrowserWindow, clipboard, globalShortcut, nativeImage } from "electron";
import type { ScreenshotSettings, Settings } from "@lyra/core";

import { resolveSaveDirectory } from "./screenshot-path.ts";
import {
	closeWin32Screenshot,
	hasActiveWin32Screenshot,
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

	for (const w of BrowserWindow.getAllWindows()) {
		if (!w.isDestroyed() && !w.webContents.isDestroyed()) {
			w.webContents.send("screenshot:captured", dataUrl);
		}
	}
	prewarmScreenshotOverlay();

	const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
	const buffer = Buffer.from(base64Data, "base64");

	const copyToClipboard = settings?.copyToClipboard !== false;
	if (copyToClipboard) {
		const img = nativeImage.createFromBuffer(buffer);
		clipboard.writeImage(img);
	}

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

export function registerScreenshotShortcut(getSettings: () => Settings | undefined): void {
	currentSettingsProvider = getSettings;

	let shortcut = getSettings()?.screenshot?.shortcut?.trim();
	if (shortcut) {
		shortcut = shortcut.replace(/Option/gi, "Alt");
		shortcut = shortcut.replace(/Command\+/gi, "CommandOrControl+");
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
	if (activeShortcut) {
		try {
			globalShortcut.unregister(activeShortcut);
		} catch {}
		activeShortcut = null;
	}
}
