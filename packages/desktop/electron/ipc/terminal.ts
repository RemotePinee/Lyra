/**
 * The embedded terminal.
 *
 * A pty per tab, kept in a map so the renderer can address one by id. The window is reached through
 * a getter rather than held: it is replaced when the app is reopened from the dock, and a captured
 * reference would go on writing to a window nobody can see.
 */

import { ipcMain, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";

export interface TerminalIpcDeps {
	terminals: Map<string, IPty>;
	spawnPty: (file: string, args: string[], options: Record<string, unknown>) => IPty;
	insideAProject(target: string): boolean;
	window(): BrowserWindow | null;
}

export function registerTerminalIpc({ terminals, spawnPty, insideAProject, window }: TerminalIpcDeps): void {
	ipcMain.handle("terminal:create", async (_event, cwd: string, cols: number, rows: number) => {
		const id = randomUUID();
		const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/bash");
		const child = spawnPty(shell, [], {
			name: "xterm-256color",
			cols: Math.max(2, cols),
			rows: Math.max(2, rows),
			cwd: insideAProject(cwd) ? cwd : process.env.HOME || process.cwd(),
			// TERM is what makes a shell emit colour and use cursor addressing at all.
			env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
		});

		child.onData((data) => window()?.webContents.send("terminal:data", { id, data }));
		child.onExit(({ exitCode }) => {
			terminals.delete(id);
			window()?.webContents.send("terminal:exit", { id, code: exitCode });
		});
		terminals.set(id, child);
		return id;
	});

	ipcMain.on("terminal:write", (_event, id: string, data: string) => terminals.get(id)?.write(data));

	ipcMain.on("terminal:resize", (_event, id: string, cols: number, rows: number) => {
		// A zero dimension is fatal to the pty; the renderer can briefly report one mid-layout.
		try {
			terminals.get(id)?.resize(Math.max(2, cols), Math.max(2, rows));
		} catch {}
	});

	ipcMain.on("terminal:kill", (_event, id: string) => {
		terminals.get(id)?.kill();
		terminals.delete(id);
	});
}
