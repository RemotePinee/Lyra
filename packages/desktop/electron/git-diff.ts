/**
 * What has changed in the working tree.
 *
 * Reads the diff itself rather than asking git to format one: the UI needs hunks it can render and
 * count, not a patch to display. Large files are capped — a generated bundle is not something
 * anyone reviews line by line, and holding it in memory helps nobody.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { computeDiff, type DiffHunk } from "@lyra/core";
import type { WorkspaceDiffFile } from "./ipc-types.ts";
import { git, MAX_BLOB_BYTES, MAX_FILES } from "./git-exec.ts";
import { gitBranch, isGitRepo } from "./git.ts";

/**
 * Uncommitted changes, as the review panel shows them.
 *
 * `git status --porcelain` gives the file list; the before/after blobs come from `git show`
 * and the working tree, and the hunks are computed locally so the UI gets structured lines
 * rather than a patch it would have to parse.
 */
export async function collectWorkspaceDiff(
	cwd: string,
): Promise<{ files: WorkspaceDiffFile[]; added: number; removed: number; branch: string | null }> {
	if (!(await isGitRepo(cwd))) return { files: [], added: 0, removed: 0, branch: null };

	const branch = await gitBranch(cwd);
	/*
	 * `-uall`, not the default.
	 *
	 * Left to itself, git collapses a wholly-untracked directory into a single entry — `src/`
	 * rather than the forty files under it. The panel could then only say "this directory is
	 * untracked", which is useless for the case that matters most: a new feature's worth of
	 * files that nobody has looked at yet. It also made the change bar disagree with the panel,
	 * since counting walks the real file list.
	 */
	const status = await git(cwd, ["status", "--porcelain=v1", "-uall", "-z"]).catch(() => "");
	const entries = status.split("\0").filter(Boolean);

	const files: WorkspaceDiffFile[] = [];
	let totalAdded = 0;
	let totalRemoved = 0;

	for (const entry of entries.slice(0, MAX_FILES)) {
		const code = entry.slice(0, 2);
		const path = entry.slice(3);
		if (!path) continue;

		const kind = classify(code);
		const before = kind === "added" || kind === "untracked" ? "" : await showHead(cwd, path);
		const after = kind === "deleted" ? "" : await readWorking(cwd, path);
		if (before === null || after === null) continue;

		const diff = computeDiff(before, after);
		totalAdded += diff.added;
		totalRemoved += diff.removed;
		files.push({ path, status: kind, added: diff.added, removed: diff.removed, hunks: capHunks(diff.hunks) });
	}

	files.sort((a, b) => a.path.localeCompare(b.path));
	return { files, added: totalAdded, removed: totalRemoved, branch };
}

export function classify(code: string): WorkspaceDiffFile["status"] {
	if (code.includes("?")) return "untracked";
	if (code.includes("A")) return "added";
	if (code.includes("D")) return "deleted";
	if (code.includes("R")) return "renamed";
	return "modified";
}

async function showHead(cwd: string, path: string): Promise<string | null> {
	return git(cwd, ["show", `HEAD:${path}`]).catch(() => "");
}

async function readWorking(cwd: string, path: string): Promise<string | null> {
	const buffer = await readFile(join(cwd, path)).catch(() => null);
	if (!buffer) return "";
	// Binary blobs and huge generated files are listed but not diffed line by line.
	if (buffer.length > MAX_BLOB_BYTES || buffer.includes(0)) return null;
	return buffer.toString("utf8");
}

/** Keep the payload sane for files with hundreds of hunks. */
export function capHunks(hunks: DiffHunk[]): DiffHunk[] {
	return hunks.slice(0, 40);
}
