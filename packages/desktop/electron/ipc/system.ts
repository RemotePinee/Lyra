/**
 * Asking the operating system to do something.
 *
 * Opening a path, launching an editor, fetching an app icon. Small, but not trivial: each one hands
 * a renderer-supplied string to the OS, so the guard matters more than the call.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { lyraHome } from "@lyra/core";
import { clipboard, ipcMain, screen, shell } from "electron";
import { remoteImage } from "../avatars.ts";
import { openTargets, openWith, type OpenTarget } from "../open-targets.ts";
import { createSessionWindow } from "../window.ts";
import { destroyDragGhost, hideDragGhost, moveDragGhost } from "../tab-drag-ghost.ts";

export function registerSystemIpc(): void {
	ipcMain.handle("system:openPath", async (_event, path: string) => void shell.openPath(path));

	ipcMain.handle(
		"system:dragGhost",
		(event, action: "show" | "move" | "hide" | "destroy", payload?: { title?: string; x?: number; y?: number }) => {
			if (action === "show" || action === "move") {
				moveDragGhost(payload?.title, event.sender.id);
			} else if (action === "hide") {
				hideDragGhost();
			} else if (action === "destroy") {
				destroyDragGhost();
			}
		},
	);

	ipcMain.handle("system:openExternal", async (event, url: string) => {
		if (url.startsWith("lyra://session/")) {
			const parsed = new URL(url);
			const sessionId = parsed.pathname.replace(/^\/+/, "").trim() || parsed.hostname;
			const posX = parsed.searchParams.get("x");
			const posY = parsed.searchParams.get("y");
			// If not provided in URL, grab the exact physical cursor position at this exact drop moment
			const initialPosition = posX && posY
				? { x: Number.parseFloat(posX), y: Number.parseFloat(posY) }
				: screen.getCursorScreenPoint();
			if (sessionId) {
				createSessionWindow(sessionId, initialPosition, event.sender);
				return;
			}
		}
		// Only ever hand http(s) to the OS handler; a file:// or custom scheme would be an escape hatch.
		try {
			const parsed = new URL(url);
			if (parsed.protocol === "http:" || parsed.protocol === "https:") await shell.openExternal(url);
		} catch {}
	});

	/*
	 * 「用什么打开」, which is a different question on every platform — see `open-targets.ts`.
	 *
	 * `target` is an id the renderer got from `system:openTargets`, or whatever an older version of
	 * the settings happens to hold; both are resolved there rather than here.
	 */
	ipcMain.handle("system:openIn", async (_event, target: string, path: string) => openWith(target, path));

	ipcMain.handle("system:openTargets", async (): Promise<OpenTarget[]> => openTargets());

	ipcMain.handle("system:revealSkillsDir", async (_event, scope: "workspace" | "user", cwd: string) => {
		const dir = scope === "workspace" ? join(cwd, ".lyra", "skills") : join(lyraHome(), "skills");
		await mkdir(dir, { recursive: true });
		await shell.openPath(dir);
		return dir;
	});

	ipcMain.handle("system:platform", async () => process.platform);

	/*
	 * A picture named by a Markdown file, fetched here so the page's CSP does not have to open up.
	 *
	 * The same trade as `registry:icon` and `git:avatar`, for the same reason: `img-src` is
	 * `self data: blob:` and widening it to the whole web — so that a README's build badge draws —
	 * would widen it for every screen in the app, permanently. `remoteImage` bounds what comes back
	 * (https only, an image content-type, half a megabyte, nine seconds) and caches it, so a
	 * document with twenty badges is twenty requests once and none after.
	 *
	 * Only reached for documents the user opened off their own disk — see `Markdown`'s `remoteImages`.
	 */
	ipcMain.handle("system:remoteImage", async (_event, url: string): Promise<string | null> => remoteImage(url));

	/*
	 * The clipboard, from here rather than from `navigator.clipboard`.
	 *
	 * Reading it in the renderer needs the `clipboard-read` permission, which nothing in this app
	 * grants — so a paste item in a context menu would work under the dev server, where the
	 * permission is waived, and quietly do nothing in the packaged app. Writing goes the same way
	 * only so that both halves are one mechanism.
	 */
	ipcMain.handle("clipboard:read", async () => clipboard.readText());
	ipcMain.handle("clipboard:write", async (_event, text: string) => clipboard.writeText(text));
}
