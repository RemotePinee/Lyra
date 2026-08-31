/**
 * Screen capture service for macOS desktop integration.
 *
 * Uses native macOS `/usr/sbin/screencapture` utility with interactive selection mode (`-i`).
 * Handles saving to custom location or temp scratch, clipboard copy, and emitting data URLs.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, clipboard, globalShortcut, nativeImage } from "electron";
import type { ScreenshotSettings, Settings } from "@lyra/core";
import { resolveSaveDirectory } from "./screenshot-path.ts";

const execFileAsync = promisify(execFile);

export interface CaptureResult {
	ok: boolean;
	canceled?: boolean;
	dataUrl?: string;
	filePath?: string;
	error?: string;
}

let activeShortcut: string | null = null;
let onCaptureTriggered: (() => void) | null = null;

/**
 * Format a timestamp filename for screenshot: Screenshot 2026-08-30 at 14.30.00.png
 */
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
 * Take an interactive screenshot on macOS using screencapture CLI.
 */
export async function captureScreen(settings?: ScreenshotSettings): Promise<CaptureResult> {
	if (process.platform !== "darwin") {
		return { ok: false, error: "系统截图功能目前仅支持 macOS" };
	}

	const saveDir = settings?.saveLocation?.trim()
		? resolveSaveDirectory(settings.saveLocation, app.getPath("desktop"))
		: tmpdir();

	try {
		await mkdir(saveDir, { recursive: true });
	} catch {
		// Fallback to tmpdir if user directory cannot be created
	}

	const filename = generateScreenshotFilename();
	const targetPath = join(saveDir, filename);

	try {
		// -i: interactive (select window or drag rectangle)
		// -r: do not add dpi metadata header (keeps raw canvas friendly)
		// targetPath: file to output
		await execFileAsync("/usr/sbin/screencapture", ["-i", "-r", targetPath]);

		// screencapture exits with code 0 even if canceled (ESC), but does not create the file.
		const buffer = await readFile(targetPath).catch(() => null);
		if (!buffer || buffer.length === 0) {
			return { ok: true, canceled: true };
		}

		const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;

		// Copy to system clipboard if preferred
		if (settings?.copyToClipboard !== false) {
			try {
				const img = nativeImage.createFromBuffer(buffer);
				clipboard.writeImage(img);
			} catch (err) {
				console.warn("[screenshot] 写入剪贴板失败:", err);
			}
		}

		// If user did not specify a persistent saveLocation, remove the temp file
		let finalPath: string | undefined = targetPath;
		if (!settings?.saveLocation?.trim()) {
			await rm(targetPath, { force: true }).catch(() => {});
			finalPath = undefined;
		}

		return {
			ok: true,
			canceled: false,
			dataUrl,
			filePath: finalPath,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message };
	}
}

/**
 * Register or update global shortcut for screenshot.
 */
export function registerScreenshotShortcut(
	getSettings: () => Settings | undefined,
	onTrigger: () => void,
): void {
	if (process.platform !== "darwin") return;

	onCaptureTriggered = onTrigger;
	let shortcut = getSettings()?.screenshot?.shortcut?.trim();
	if (shortcut) {
		// Normalize "Option+" to "Alt+" for Electron's Accelerator parser
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
