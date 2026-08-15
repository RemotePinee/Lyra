/**
 * Commits, and the differences between them.
 *
 * `gitLog` carries the parent ids because the graph beside it is drawn from them; without those the
 * column of dots would be a list, not a history.
 */

import { computeDiff } from "@deepwise/core";
import type { GitCommit, WorkspaceDiffFile } from "./ipc-types.ts";
import { git, run, MAX_BLOB_BYTES, MAX_FILES } from "./git-exec.ts";
import { capHunks, classify } from "./git-diff.ts";
import { EMPTY_TREE, LOG_FORMAT } from "./git-status.ts";
import { gitBranch, isGitRepo } from "./git.ts";

export async function gitLog(cwd: string, limit = 60, ref?: string): Promise<GitCommit[]> {
	if (!(await isGitRepo(cwd))) return [];
	const out = await git(cwd, [
		"log",
		"--topo-order",
		`--max-count=${Math.min(limit, 300)}`,
		`--format=${LOG_FORMAT}`,
		...(ref ? [ref] : []),
	]).catch(() => "");

	return out
		.split("\x1e")
		.map((record) => record.replace(/^\n/, ""))
		.filter(Boolean)
		.map((record) => {
			const [sha, shortSha, subject, author, date, refs, parents] = record.split("\x1f");
			return {
				sha,
				shortSha,
				subject,
				parents: (parents ?? "").split(" ").filter(Boolean),
				author,
				date,
				refs: (refs ?? "")
					.split(", ")
					.map((name) => name.replace(/^HEAD -> /, "").trim())
					.filter((name) => name && name !== "HEAD"),
			};
		});
}

/**
 * The diff between any two points in history.
 *
 * One implementation for three questions — what a commit changed, how two branches differ, what
 * is staged — because to git they are the same question with different endpoints. `base` of
 * `null` means the index, which is how the staged view gets its content.
 */
export async function diffRefs(
	cwd: string,
	base: string,
	head: string | null,
): Promise<{ files: WorkspaceDiffFile[]; added: number; removed: number }> {
	if (!(await isGitRepo(cwd))) return { files: [], added: 0, removed: 0 };

	const range = head ? [base, head] : ["--cached", base];
	const names = await git(cwd, ["diff", "--name-status", "-z", ...range]).catch(() => "");

	const files: WorkspaceDiffFile[] = [];
	let added = 0;
	let removed = 0;

	const tokens = names.split("\0").filter(Boolean);
	for (let i = 0; i < tokens.length && files.length < MAX_FILES; i++) {
		const code = tokens[i];
		if (!/^[A-Z]/.test(code)) continue;
		// A rename spends three tokens: the code, the old path and the new one.
		const isRename = code.startsWith("R");
		const path = tokens[isRename ? i + 2 : i + 1];
		if (isRename) i += 2;
		else i += 1;
		if (!path) continue;

		const status = classify(code[0]);
		const [before, after] = await Promise.all([
			status === "added" ? Promise.resolve("") : blobAt(cwd, head ? base : "HEAD", path),
			status === "deleted" ? Promise.resolve("") : head ? blobAt(cwd, head, path) : stagedBlob(cwd, path),
		]);
		if (before === null || after === null) continue;

		// Counted from the diff itself rather than from `--numstat`, so the totals and the hunks
		// on screen can never disagree.
		const diff = computeDiff(before, after);
		added += diff.added;
		removed += diff.removed;
		files.push({ path, status, added: diff.added, removed: diff.removed, hunks: capHunks(diff.hunks) });
	}

	return { files, added, removed };
}

/** A commit's own diff — against its parent, or against nothing if it is the first. */
export async function commitDiff(cwd: string, sha: string) {
	const parent = await git(cwd, ["rev-parse", "--verify", `${sha}^`])
		.then((out) => out.trim())
		.catch(() => EMPTY_TREE);
	return diffRefs(cwd, parent, sha);
}

async function blobAt(cwd: string, ref: string, path: string): Promise<string | null> {
	const out = await git(cwd, ["show", `${ref}:${path}`]).catch(() => null);
	if (out === null) return "";
	return out.length > MAX_BLOB_BYTES ? null : out;
}

async function stagedBlob(cwd: string, path: string): Promise<string | null> {
	const out = await git(cwd, ["show", `:${path}`]).catch(() => null);
	if (out === null) return "";
	return out.length > MAX_BLOB_BYTES ? null : out;
}

export async function createBranch(cwd: string, name: string, from?: string) {
	const clean = name.trim();
	if (!clean) return { ok: false, error: "分支名不能为空" };
	return run(cwd, ["switch", "-c", clean, ...(from ? [from] : [])]);
}

export async function deleteBranch(cwd: string, name: string, force = false) {
	return run(cwd, ["branch", force ? "-D" : "-d", name]);
}

export async function pushBranch(cwd: string): Promise<{ ok: boolean; error?: string }> {
	const branch = await gitBranch(cwd);
	if (!branch) return { ok: false, error: "当前不在任何分支上" };
	// `-u` on the first push, so the branch gains an upstream instead of failing for want of one.
	const hasUpstream = await git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]).then(() => true).catch(() => false);
	return run(cwd, hasUpstream ? ["push"] : ["push", "-u", "origin", branch]);
}

export async function pullBranch(cwd: string): Promise<{ ok: boolean; error?: string }> {
	// `--ff-only`: a merge commit, or worse a conflict, is not something to start from a button.
	return run(cwd, ["pull", "--ff-only"]);
}

/**
 * Commit what is staged.
 *
 * Unlike `commitAll`, which the composer's bar uses, this one records exactly what the panel
 * shows as staged — the whole point of having an index in front of you.
 */
export async function commitStaged(cwd: string, message: string): Promise<{ ok: boolean; error?: string }> {
	const trimmed = message.trim();
	if (!trimmed) return { ok: false, error: "提交信息不能为空" };
	const staged = await git(cwd, ["diff", "--cached", "--name-only"]).catch(() => "");
	if (!staged.trim()) return { ok: false, error: "没有已暂存的改动" };
	return run(cwd, ["commit", "-m", trimmed]);
}
