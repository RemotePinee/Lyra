/**
 * What 「用什么打开」 can mean on this machine.
 *
 * Two things used to be conflated here. The setting stored an application's macOS display name and
 * the handler ran `open -a` with it, which made the whole feature macOS-only — on Windows and Linux
 * every choice fell through to `shell.openPath`, so picking an editor did nothing and the list
 * still offered Finder, Ghostty and Xcode. And 「Finder」 was treated as an application to open the
 * file *with*, so choosing it handed the file to the Finder to launch rather than showing you where
 * it lives, which is the only thing anyone means by it.
 *
 * So a target is now one of three kinds, and the list is what this machine actually has:
 *
 *   reveal    show the file where it lives, in whatever this platform calls its file manager
 *   app       open the file with an application
 *   terminal  open a shell in the file's directory — never *at* the file, which would run it
 *
 * Ids are stable and platform-neutral (`vscode`, not `Visual Studio Code`), because settings sync
 * between machines: a choice made on a Mac has to still mean something on a PC. The names the old
 * setting stored are accepted as aliases so nobody's choice is lost.
 */

import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { app, shell } from "electron";
import { appIcon, findApp } from "./app-icon.ts";
import { ALIASES, CANDIDATES, type Candidate, resolveTargetId, revealLabel } from "./open-target-ids.ts";

const execFileAsync = promisify(execFile);

export interface OpenTarget {
	/** Stable across platforms and versions; this is what settings store. */
	id: string;
	label: string;
	/** A data URL of the application's own icon, where the platform can produce one. */
	icon?: string;
	/**
	 * What this target used to be called in the settings file.
	 *
	 * Sent to the renderer so that recognising a stored value is a lookup rather than a second copy
	 * of the alias table living over there and drifting from this one.
	 */
	aliases: string[];
}

/** Where a candidate's executable is on this machine, or null if it is not installed. */
async function locate(candidate: Candidate): Promise<string | null> {
	if (process.platform === "darwin") return candidate.appName ? findApp(candidate.appName) : null;

	for (const fixed of candidate.windows ?? []) {
		const base =
			fixed.dir === "localAppData"
				? process.env.LOCALAPPDATA
				: fixed.dir === "programFiles"
					? process.env.ProgramFiles
					: fixed.dir === "programFilesX86"
						? process.env["ProgramFiles(x86)"]
						: process.env.windir;
		if (!base) continue;
		const path = join(base, fixed.path);
		if (await access(path).then(() => true).catch(() => false)) return path;
	}

	if (!candidate.command) return null;
	const finder = process.platform === "win32" ? "where" : "which";
	const { stdout } = await execFileAsync(finder, [candidate.command]).catch(() => ({ stdout: "" }));
	const hit = stdout.split("\n")[0]?.trim();
	return hit || null;
}

/**
 * The icon an installed application already has.
 *
 * macOS reads it out of the bundle; Windows asks the shell for the executable's icon, which is the
 * same one the taskbar draws. Linux keeps icons in theme directories under names that have nothing
 * to do with the binary, so there is none — the row is a plain label, which is what it was
 * everywhere before this.
 */
async function iconFor(candidate: Candidate, located: string): Promise<string | undefined> {
	if (process.platform === "darwin") return (candidate.appName ? await appIcon(candidate.appName) : null) ?? undefined;
	if (process.platform !== "win32") return undefined;
	try {
		const image = await app.getFileIcon(located, { size: "normal" });
		return image.isEmpty() ? undefined : image.toDataURL();
	} catch {
		return undefined;
	}
}

/** Resolved once: applications are installed about as often as the app is restarted. */
let cached: Promise<OpenTarget[]> | null = null;

export function openTargets(): Promise<OpenTarget[]> {
	cached ??= build();
	return cached;
}

async function build(): Promise<OpenTarget[]> {
	const found: OpenTarget[] = [{ id: "reveal", label: `在${revealLabel()}中显示`, aliases: aliasesFor("reveal") }];

	for (const candidate of CANDIDATES[process.platform] ?? []) {
		const located = await locate(candidate).catch(() => null);
		if (!located) continue;
		const icon = await iconFor(candidate, located).catch(() => undefined);
		found.push({
			id: candidate.id,
			label: candidate.label,
			aliases: aliasesFor(candidate.id),
			...(icon ? { icon } : {}),
		});
	}

	return found;
}

function aliasesFor(id: string): string[] {
	return Object.entries(ALIASES)
		.filter(([, target]) => target === id)
		.map(([alias]) => alias);
}

/**
 * Act on a target.
 *
 * Everything unknown — an id from a platform this machine is not, a setting written by a newer
 * version — hands the path to the system's own default handler rather than failing. The user asked
 * for the file to open; which application does it is the part we might be wrong about.
 */
export async function openWith(stored: string, path: string): Promise<void> {
	const id = resolveTargetId(stored);
	if (id === "reveal") {
		shell.showItemInFolder(path);
		return;
	}

	const candidate = (CANDIDATES[process.platform] ?? []).find((entry) => entry.id === id);
	if (!candidate) {
		await shell.openPath(path);
		return;
	}

	// A terminal opens *in* a directory. Handed a file it would try to run it, which on macOS is
	// exactly what `open -a Terminal file.ts` does.
	const target = candidate.kind === "terminal" ? await containingDirectory(path) : path;

	try {
		if (process.platform === "darwin" && candidate.appName) {
			await execFileAsync("open", ["-a", candidate.appName, target]);
			return;
		}
		const located = await locate(candidate);
		if (!located) {
			await shell.openPath(target);
			return;
		}
		/*
		 * Detached, and its streams released.
		 *
		 * A GUI editor launched as a child of this process keeps a handle on our stdio; on Windows
		 * an unreferenced child also keeps the app alive on quit. Neither matters until it does,
		 * and both are one option each.
		 */
		const child = execFile(located, [target], { windowsHide: false });
		child.on("error", () => void shell.openPath(target));
		child.unref();
	} catch {
		await shell.openPath(target);
	}
}

async function containingDirectory(path: string): Promise<string> {
	const info = await stat(path).catch(() => null);
	return info?.isDirectory() ? path : dirname(path);
}
