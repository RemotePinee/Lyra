/**
 * The handful of things that are not the same on every platform.
 *
 * Each of these was, until recently, written inline wherever it was needed — and each inline copy
 * was written for Unix, because that is what the machine under the keyboard was. None of them are
 * hard; they are simply invisible on the platform you develop on, and they stay invisible until
 * something runs somewhere else. When the release workflow first built on Windows, six of them
 * failed at once.
 *
 * So they live here, once, with the reason attached. The rule for adding to this file: if the
 * answer depends on `process.platform`, or on a separator, or on which environment variable a
 * concept happens to be spelled with, it belongs here rather than at the call site.
 */

import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import { TextDecoder } from "node:util";
import { execFileSync } from "node:child_process";

let cachedWinShell: { file: string; flag: string } | null = null;

function probeWindowsShell(): { file: string; flag: string } {
	if (cachedWinShell) return cachedWinShell;

	// 1. Respect explicit user SHELL preference (e.g. bash / zsh / custom pwsh)
	if (process.env.SHELL) {
		return (cachedWinShell = { file: process.env.SHELL, flag: "-c" });
	}

	// 2. Prefer PowerShell 7+ (pwsh.exe) which natively supports '&&', '||', and POSIX features
	try {
		execFileSync("where.exe", ["pwsh.exe"], { stdio: "ignore" });
		return (cachedWinShell = { file: "pwsh.exe", flag: "-Command" });
	} catch {}

	// 3. Prefer Git Bash (bash.exe) if installed, giving standard POSIX shell compatibility
	try {
		execFileSync("where.exe", ["bash.exe"], { stdio: "ignore" });
		return (cachedWinShell = { file: "bash.exe", flag: "-c" });
	} catch {}

	// 4. Fallback to cmd.exe which is guaranteed to exist on all Windows installations
	return (cachedWinShell = { file: process.env.ComSpec || "cmd.exe", flag: "/c" });
}

/**
 * The shell to run a command line through, and the flag that says "here is the command".
 *
 * On Windows, default `powershell.exe` (Windows PowerShell 5.1) does not support `&&` or `||`,
 * so commands chained with `&&` fail with ParserError. We probe for modern PowerShell 7 (`pwsh.exe`),
 * falling back to `cmd.exe` or respecting `process.env.SHELL`.
 */
export function systemShell(): { file: string; flag: string } {
	if (process.platform === "win32") {
		return probeWindowsShell();
	}
	return { file: process.env.SHELL || "/bin/bash", flag: "-c" };
}

/**
 * Where the user's home directory is.
 *
 * `os.homedir()` rather than `process.env.HOME`, because Windows spells it `USERPROFILE` and
 * `HOME` is usually unset there. Reading the variable directly gave `undefined`, and the code
 * around it then built paths beginning with the string "undefined".
 */
export const home = (): string => homedir();

/**
 * Is `target` inside `root` — the directory itself not counting as inside itself.
 *
 * Asked of `path`, never spelled out. The natural way to write this is
 * `` target.startsWith(`${root}/`) ``, and it is correct on Unix and quietly false on Windows for
 * every input, because the separator there is a backslash. A containment check that always answers
 * "no" does not look broken; it looks like the thing being asked about simply is not there. That
 * is how it survived: on Windows every MCP bundle was misfiled and every scratch directory looked
 * foreign, and nothing said so.
 *
 * Relative paths are never inside anything: the question only means something between two places
 * that are both pinned down.
 */
export function within(root: string, target: string): boolean {
	if (!isAbsolute(root) || !isAbsolute(target)) return false;
	const step = relative(root, target);
	return step !== "" && !step.startsWith("..") && !isAbsolute(step);
}

/** `within`, but the root counts as inside itself — for "may write here" rather than "is under". */
export const withinOrIs = (root: string, target: string): boolean =>
	root === target || within(root, target);

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
let gbkDecoder: TextDecoder | null = null;

/**
 * Decode stdout/stderr chunks from child processes.
 *
 * On Windows with East Asian locales, child processes (e.g. system commands or cmd/powershell errors)
 * emit output in OEM code pages (such as GBK/CP936). Raw UTF-8 decoding turns these bytes into mojibake.
 * This decodes as UTF-8 first and falls back to GBK if UTF-8 validation fails.
 */
export function decodeProcessOutput(chunk: Buffer): string {
	try {
		return utf8Decoder.decode(chunk);
	} catch {
		try {
			gbkDecoder ??= new TextDecoder("gbk");
			return gbkDecoder.decode(chunk);
		} catch {
			return chunk.toString("utf8");
		}
	}
}
