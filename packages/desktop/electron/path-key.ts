/**
 * One spelling for a path, so that two of them can be compared.
 *
 * The same directory reaches this process under several names, and none of the differences are
 * visible when reading the code:
 *
 * - git prints `C:/Users/me/project` where `path.join` produces `C:\Users\me\project`
 * - Windows paths are case-insensitive, so `C:\Users` and `c:\users` are one directory
 * - `os.tmpdir()` can return an 8.3 short name (`C:\Users\RUNNER~1\...`) where git returns the
 *   long one, and on macOS returns `/var/folders/...` where realpath gives `/private/var/...`
 *
 * Comparing raw strings therefore answers "different" about a directory that is the same one, and
 * every such answer is a silent bug rather than an error. The one that prompted this: the guard in
 * `cleanOldWorktrees` that refuses to delete a worktree a live session is using compares a path
 * from `git worktree list` against a set built with `path.join`. On Windows those never matched,
 * so the guard never fired and the cleanup deleted whatever the user was working in.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A path in the form this platform writes it: real separators, no `..`, no short names.
 *
 * `realpath` rather than `resolve` alone, because it is what expands an 8.3 short name, follows a
 * symlink and settles the true case of every segment. It needs the path to exist, so a deleted or
 * not-yet-created directory falls back to `resolve`, which still fixes the separators and the `..`.
 *
 * The case is left as the filesystem reports it. This is the form to hand back to a caller or put
 * on screen — `pathKey` is the one to compare with.
 */
export function canonicalPath(input: string): string {
	try {
		return realpathSync.native(input);
	} catch {
		return resolve(input);
	}
}

/**
 * The same path reduced to something two of them can be compared by.
 *
 * Lowercased only where the filesystem is case-insensitive. macOS usually is too, but `realpath`
 * has already returned the true case there, and folding a path on a case-sensitive filesystem — a
 * Linux checkout with `Foo` and `foo` side by side — would merge two real directories into one.
 *
 * Not for display: on Windows this returns `c:\users\…`, which is a correct path and a wrong thing
 * to show someone.
 */
export function pathKey(input: string): string {
	const path = canonicalPath(input);
	return process.platform === "win32" ? path.toLowerCase() : path;
}

/** Whether two paths name the same directory, however each of them happens to be spelled. */
export function samePath(a: string, b: string): boolean {
	return pathKey(a) === pathKey(b);
}
