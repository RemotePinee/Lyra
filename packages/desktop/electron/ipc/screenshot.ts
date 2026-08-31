/**
 * IPC handlers for screenshot capabilities.
 */

import { dialog, ipcMain } from "electron";
import type { ScreenshotSettings, Settings } from "@lyra/core";
import { captureScreen, checkShortcutAvailable, type CaptureResult } from "../screenshot.ts";

export interface ScreenshotIpcDeps {
	settings: () => Settings;
	saveSettings: (next: Settings) => Promise<void>;
}

export function registerScreenshotIpc(deps: ScreenshotIpcDeps): void {
	ipcMain.handle("screenshot:validateShortcut", (_event, shortcut: string) => {
		return checkShortcutAvailable(shortcut);
	});

	ipcMain.handle("screenshot:capture", async (_event, customSettings?: ScreenshotSettings): Promise<CaptureResult> => {
		const current = customSettings ?? deps.settings().screenshot;
		return captureScreen(current);
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
