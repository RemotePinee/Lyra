/**
 * The terminal's IPC surface: messages in, registry calls out.
 *
 * Everything this forwards to — which shell an attach lands on, what survives a detach — lives in
 * `terminal-registry.ts`, which has no Electron in it and is tested directly.
 */

import { ipcMain } from "electron";
import { createTerminalRegistry, type TerminalDeps } from "../terminal-registry.ts";

export type { Attached, LiveTerminal, TerminalDeps, TerminalTab } from "../terminal-registry.ts";

export function registerTerminalIpc(deps: TerminalDeps): void {
	const registry = createTerminalRegistry(deps);
	ipcMain.handle("terminal:list", async (_event, cwd: string) => registry.list(cwd));
	ipcMain.handle("terminal:open", async (_event, cwd: string, cols: number, rows: number) =>
		registry.open(cwd, cols, rows),
	);
	ipcMain.handle("terminal:attach", async (_event, id: string, cols: number, rows: number) =>
		registry.attach(id, cols, rows),
	);
	ipcMain.on("terminal:detach", (_event, id: string, epoch: number) => registry.detach(id, epoch));
	ipcMain.on("terminal:write", (_event, id: string, data: string) => registry.write(id, data));
	ipcMain.on("terminal:resize", (_event, id: string, cols: number, rows: number) => registry.resize(id, cols, rows));
	ipcMain.on("terminal:kill", (_event, id: string) => registry.kill(id));
}
