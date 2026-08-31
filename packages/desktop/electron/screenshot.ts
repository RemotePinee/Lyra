/**
 * Screen capture service for desktop integration (macOS & Windows & Linux).
 *
 * - macOS: Uses native macOS `/usr/sbin/screencapture` utility with interactive selection mode (`-i`).
 * - Windows / Linux: Uses native screenshot capture with clipboard & file output support.
 * Handles saving to custom location or temp scratch, clipboard copy, and emitting data URLs.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, clipboard, globalShortcut, nativeImage } from "electron";
import type { ScreenshotSettings, Settings } from "@lyra/core";
import { resolveSaveDirectory } from "./screenshot-path.ts";
import { openSnippingOverlay } from "./snipping-overlay.ts";

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
 * Capture screen on Windows or Linux using native interactive snipping overlay.
 */
async function captureScreenNonDarwin(saveDir: string, settings?: ScreenshotSettings): Promise<CaptureResult> {
	const snippingRes = await openSnippingOverlay();
	if (snippingRes.canceled) {
		return { ok: true, canceled: true };
	}
	if (!snippingRes.dataUrl) {
		return { ok: false, error: snippingRes.error || "未完成选区截取" };
	}

	try {
		const dataUrl = snippingRes.dataUrl;
		const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
		const buffer = Buffer.from(base64Data, "base64");
		const img = nativeImage.createFromBuffer(buffer);

		// Copy into clipboard for immediate paste convenience
		clipboard.writeImage(img);

		let finalPath: string | undefined;
		if (settings?.saveLocation?.trim()) {
			const filename = generateScreenshotFilename();
			finalPath = join(saveDir, filename);
			await writeFile(finalPath, buffer);
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
 * Take an interactive screenshot using macOS screencapture CLI or cross-platform capturer.
 */
export async function captureScreen(settings?: ScreenshotSettings): Promise<CaptureResult> {
	const saveDir = settings?.saveLocation?.trim()
		? resolveSaveDirectory(settings.saveLocation, app.getPath("desktop"))
		: tmpdir();

	try {
		await mkdir(saveDir, { recursive: true });
	} catch {
		// Fallback to tmpdir if user directory cannot be created
	}

	if (process.platform !== "darwin") {
		return captureScreenNonDarwin(saveDir, settings);
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

/**
 * Register or update global shortcut for screenshot.
 */
export function registerScreenshotShortcut(
	getSettings: () => Settings | undefined,
	onTrigger: () => void,
): void {
	onCaptureTriggered = onTrigger;
	let shortcut = getSettings()?.screenshot?.shortcut?.trim();
	if (shortcut) {
		// Normalize "Option+" to "Alt+" for Electron's Accelerator parser
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
			onCaptureTriggered?.();
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
	onCaptureTriggered = null;
}
