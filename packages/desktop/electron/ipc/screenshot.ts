/**
 * IPC handlers for screenshot capabilities.
 */

import { dialog, ipcMain } from "electron";
import type { ScreenshotSettings, Settings } from "@lyra/core";
import {
	closeScreenshotOverlay,
	finishScreenshot,
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

	ipcMain.handle("screenshot:cancel", async (): Promise<void> => {
		closeScreenshotOverlay();
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
