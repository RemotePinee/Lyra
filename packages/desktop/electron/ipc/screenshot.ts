/**
 * IPC handlers for screenshot capabilities.
 */

import { clipboard, dialog, ipcMain } from "electron";
import type { ScreenshotSettings, Settings } from "@lyra/core";
import { captureLog } from "../screenshot-debug.ts";
import {
	checkShortcutAvailable,
	closeScreenshotOverlay,
	finishScreenshot,
	overlayPainted,
	overlayPassedThrough,
	revealScreenshotOverlay,
	startScreenshotSession,
} from "../screenshot.ts";

export interface ScreenshotIpcDeps {
	settings: () => Settings;
	saveSettings: (next: Settings) => Promise<void>;
}

export function registerScreenshotIpc(deps: ScreenshotIpcDeps): void {
	ipcMain.handle("screenshot:validateShortcut", (_event, shortcut: string) => {
		return checkShortcutAvailable(shortcut);
	});

	/*
	 * A capture that cannot start says so in the log, not on the user's screen.
	 *
	 * `ipcMain.handle` sends a throw back across the bridge, where the caller — the composer's
	 * button — does not await it, so it lands as an unhandled rejection in the renderer. The
	 * commonest reason to get here is screen recording access not being granted yet, and macOS is
	 * already showing its own dialog about exactly that.
	 */
	ipcMain.handle("screenshot:start", async (_event, customSettings?: ScreenshotSettings): Promise<void> => {
		const current = customSettings ?? deps.settings().screenshot;
		try {
			await startScreenshotSession(current);
		} catch (err) {
			console.error("[screenshot] 无法开始截图:", err);
		}
	});

	ipcMain.handle("screenshot:finish", async (_event, dataUrl: string, customSettings?: ScreenshotSettings): Promise<{ ok: boolean; filePath?: string }> => {
		const current = customSettings ?? deps.settings().screenshot;
		return finishScreenshot(dataUrl, current);
	});

	/*
	 * Cancelling produces nothing, so it moves nothing.
	 *
	 * `foreground: false` is the difference between this and finishing. A capture that produced an
	 * image has somewhere to send it and Lyra comes forward to receive it; pressing Escape means
	 * "never mind", and answering that by throwing the application in front of whatever the user
	 * was reading is the opposite of never mind.
	 */
	ipcMain.handle("screenshot:cancel", async (): Promise<void> => {
		closeScreenshotOverlay({ foreground: false });
	});

	ipcMain.handle("screenshot:copyColor", async (_event, value: string): Promise<void> => {
		if (/^#[0-9A-F]{6}$/i.test(value)) clipboard.writeText(value.toUpperCase());
	});

	/*
	 * The overlay reporting that its page is mounted or painted.
	 */
	/*
	 * What the overlay measures about itself, into the same log as the main process's own steps.
	 *
	 * The question these answer is whether the frozen picture is the same shape as the screen it is
	 * covering. If it is not, it is stretched to fill — and everything in it shifts, which from the
	 * outside looks like the whole desktop scaling for an instant.
	 */
	ipcMain.on("screenshot:debug", (_event, what: string, detail: Record<string, unknown>) => {
		captureLog(`renderer: ${what}`, detail);
	});

	/*
	 * A colour was taken: the capture is over on screen, the confirmation is not.
	 *
	 * `on`, not `handle`, and not a close. The window is still up for another moment holding nothing
	 * but 「已复制色值」 over the real desktop, and this is what stops it behaving like a capture
	 * while it does — presses go through to whatever is underneath. The renderer sends
	 * `screenshot:cancel` on its own clock once the message has faded.
	 */
	ipcMain.on("screenshot:colourPicked", () => {
		overlayPassedThrough();
	});

	/*
	 * The overlay has produced a frame.
	 *
	 * Distinct from `ready`, and the distinction is the point: `ready` means the snapshot is in the
	 * canvas's bitmap, which is CPU-side and says nothing about whether the window has a composited
	 * surface to show it with. This is sent from inside an animation frame, so a frame provably
	 * exists — and only then is the window made opaque. See `reveal` in `screenshot.ts`.
	 */
	ipcMain.on("screenshot:ready", (event) => {
		if (event.sender && !event.sender.isDestroyed()) {
			revealScreenshotOverlay(event.sender.id);
		}
	});

	ipcMain.on("screenshot:painted", () => {
		overlayPainted();
	});

	ipcMain.handle("screenshot:pickDirectory", async (): Promise<string | null> => {
		const res = await dialog.showOpenDialog({
			title: "选择截图保存位置",
			properties: ["openDirectory", "createDirectory"],
		});
		if (res.canceled || res.filePaths.length === 0) return null;
		return res.filePaths[0];
	});
}
