/**
 * IPC handlers for screenshot capabilities.
 */

import { dialog, ipcMain } from "electron";
import type { ScreenshotSettings, Settings } from "@lyra/core";
import {
	closeScreenshotOverlay,
	finishScreenshot,
	revealScreenshotOverlay,
	startScreenshotSession,
} from "../screenshot.ts";

export interface ScreenshotIpcDeps {
	settings: () => Settings;
	saveSettings: (next: Settings) => Promise<void>;
}

export function registerScreenshotIpc(deps: ScreenshotIpcDeps): void {
	ipcMain.handle("screenshot:start", async (_event, customSettings?: ScreenshotSettings): Promise<void> => {
		const current = customSettings ?? deps.settings().screenshot;
		await startScreenshotSession(current);
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

	/*
	 * The overlay reporting that its snapshot is drawn.
	 *
	 * `on`, not `handle`: the renderer is telling, not asking, and it must not be made to wait for
	 * the window to be shown before it can carry on drawing. The sender identifies which overlay.
	 */
	ipcMain.on("screenshot:ready", (event) => {
		if (event.sender && !event.sender.isDestroyed()) {
			revealScreenshotOverlay(event.sender.id);
		}
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
