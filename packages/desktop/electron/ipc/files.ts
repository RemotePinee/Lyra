/**
 * Reading and writing files on the renderer's behalf.
 *
 * The renderer can name any path it likes, so every handler here starts by asking whether the path
 * is inside a project the user actually opened. That check is the whole reason these are not just
 * `fs` calls in the renderer.
 */

import { ipcMain } from "electron";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileContents, FileEntry } from "../ipc-types.ts";

export interface FilesIpcDeps {
	insideAProject(target: string): boolean;
}

export function registerFilesIpc({ insideAProject }: FilesIpcDeps): void {
	ipcMain.handle("files:list", async (_event, dir: string): Promise<FileEntry[]> => {
		if (!insideAProject(dir)) return [];
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		const out = await Promise.all(
			entries.map(async (entry) => {
				const path = join(dir, entry.name);
				const info = entry.isDirectory() ? null : await stat(path).catch(() => null);
				return { name: entry.name, path, isDirectory: entry.isDirectory(), size: info?.size ?? 0 };
			}),
		);
		// Directories first, then case-insensitive by name — the order a file list is read in.
		return out.sort((a, b) =>
			a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.isDirectory ? -1 : 1,
		);
	});

	/** Enough for any source file; past this it is generated output nobody reads in a panel. */
	const FILE_READ_CAP = 512 * 1024;

	ipcMain.handle("files:read", async (_event, path: string): Promise<FileContents | null> => {
		if (!insideAProject(path)) return null;
		const info = await stat(path).catch(() => null);
		if (!info?.isFile()) return null;

		const buffer = await readFile(path).catch(() => null);
		if (!buffer) return null;

		// A NUL byte in the first block is the classic, and reliable enough, binary tell.
		const head = buffer.subarray(0, 8000);
		if (head.includes(0)) return { text: "", truncated: false, bytes: info.size, binary: true, modifiedAt: info.mtimeMs };

		const clipped = buffer.subarray(0, FILE_READ_CAP);
		return {
			text: clipped.toString("utf8"),
			truncated: buffer.byteLength > FILE_READ_CAP,
			bytes: info.size,
			modifiedAt: info.mtimeMs,
		};
	});

	ipcMain.handle("files:write", async (_event, path: string, text: string) => {
		if (!insideAProject(path)) return { ok: false, error: "该路径不在已打开的项目内" };
		try {
			await writeFile(path, text, "utf8");
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
}
