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
import { app, clipboard, desktopCapturer, globalShortcut, screen } from "electron";
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
 * Capture screen on Windows or Linux using electron desktopCapturer or clipboard image.
 */
async function captureScreenNonDarwin(saveDir: string, settings?: ScreenshotSettings): Promise<CaptureResult> {
	try {
		// First check if user already has an image freshly copied in clipboard
		const clipImg = clipboard.readImage();
		if (!clipImg.isEmpty()) {
			// If non-empty, we can use it or capture primary display
		}

		const primaryDisplay = screen.getPrimaryDisplay();
		const { width, height } = primaryDisplay.size;
		const sources = await desktopCapturer.getSources({
			types: ["screen"],
			thumbnailSize: { width: width * primaryDisplay.scaleFactor, height: height * primaryDisplay.scaleFactor },
		});

		const primarySource = sources[0];
		if (!primarySource) {
			return { ok: false, error: "未能捕获到可用屏幕图像" };
		}

		const img = primarySource.thumbnail;
		const buffer = img.toPNG();
		const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;

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
	let normalized = shortcut?.trim();
	if (!normalized) return { ok: true };

	normalized = normalized.replace(/Option/gi, "Alt");
	normalized = normalized.replace(/Command\+/gi, "CommandOrControl+");

	if (activeShortcut && activeShortcut.toLowerCase() === normalized.toLowerCase()) {
		return { ok: true };
	}

	try {
		const isRegistered = globalShortcut.isRegistered(normalized);
		if (isRegistered) {
			return { ok: false, error: "该快捷键已被系统或其他正在运行的应用程序占用" };
		}
		// Attempt temporary test registration
		const success = globalShortcut.register(normalized, () => {});
		if (!success) {
			return { ok: false, error: "系统拒绝注册该快捷键（已被占用或受系统保护）" };
		}
		// Unregister probe immediately
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
