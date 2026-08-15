/**
 * Asking the operating system to do something.
 *
 * Opening a path, launching an editor, fetching an app icon. Small, but not trivial: each one hands
 * a renderer-supplied string to the OS, so the guard matters more than the call.
 */

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { deepwiseHome } from "@deepwise/core";
import { ipcMain, shell } from "electron";
import { appIcon } from "../app-icon.ts";

const execFileAsync = promisify(execFile);

export function registerSystemIpc(): void {
	ipcMain.handle("system:openPath", async (_event, path: string) => void shell.openPath(path));

	ipcMain.handle("system:openExternal", async (_event, url: string) => {
		// Only ever hand http(s) to the OS handler; a file:// or custom scheme would be an escape hatch.
		const parsed = new URL(url);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") await shell.openExternal(url);
	});

	ipcMain.handle("system:openIn", async (_event, appName: string, path: string) => {
		if (process.platform === "darwin") {
			await execFileAsync("open", ["-a", appName, path]).catch(() => shell.openPath(path));
		} else {
			await shell.openPath(path);
		}
	});

	ipcMain.handle("system:revealSkillsDir", async (_event, scope: "workspace" | "user", cwd: string) => {
		const dir = scope === "workspace" ? join(cwd, ".deepwise", "skills") : join(deepwiseHome(), "skills");
		await mkdir(dir, { recursive: true });
		await shell.openPath(dir);
		return dir;
	});

	ipcMain.handle("system:platform", async () => process.platform);

	ipcMain.handle("system:appIcon", async (_event, appName: string): Promise<string | null> => appIcon(appName));
}
