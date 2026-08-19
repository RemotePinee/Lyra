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

/**
 * The shell to run a command line through, and the flag that says "here is the command".
 *
 * `process.env.SHELL` is a Unix convention and is simply absent on Windows, where the previous
 * fallback — `/bin/bash` — is not a path to anything. Every command the agent ran there failed
 * with `spawn /bin/bash ENOENT`, which is to say the product's central capability did not work on
 * a platform it ships to.
 *
 * PowerShell rather than `cmd.exe`: it is present on every supported Windows, it understands the
 * `&&` and quoting that models write without being asked, and it is already what the embedded
 * terminal starts. Two different shells on one platform would be worse than either.
 */
export function systemShell(): { file: string; flag: string } {
	if (process.platform === "win32") return { file: "powershell.exe", flag: "-Command" };
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
