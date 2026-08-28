/**
 * Commits, and the differences between them.
 *
 * `gitLog` carries the parent ids because the graph beside it is drawn from them; without those the
 * column of dots would be a list, not a history.
 */

import { computeDiff } from "@lyra/core";
import type { GitCommit, WorkspaceDiffFile } from "./ipc-types.ts";
import { readBlobs, type BlobRead } from "./git-blobs.ts";
import { git, run, MAX_FILES } from "./git-exec.ts";
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

	/*
	 * The name list is parsed first, then the blobs are fetched together.
	 *
	 * Parsing has to be a walk — a rename spends three tokens where everything else spends two, so
	 * the position of the next entry depends on the current one. Fetching does not: each file's two
	 * blobs are independent, and reading them one file after another meant two process spawns of
	 * pure waiting per file. See `mapLimit`.
	 */
	const wanted: { path: string; status: WorkspaceDiffFile["status"] }[] = [];
	const tokens = names.split("\0").filter(Boolean);
	for (let i = 0; i < tokens.length && wanted.length < MAX_FILES; i++) {
		const code = tokens[i];
		if (!/^[A-Z]/.test(code)) continue;
		// A rename spends three tokens: the code, the old path and the new one.
		const isRename = code.startsWith("R");
		const path = tokens[isRename ? i + 2 : i + 1];
		if (isRename) i += 2;
		else i += 1;
		if (!path) continue;
		wanted.push({ path, status: classify(code[0]) });
	}

	/*
	 * Both sides in two batches, rather than two `git show` processes per file.
	 *
	 * The "before" side is whichever ref the comparison starts from; the "after" side is the other
	 * ref, or the index when there is no second ref — `:path` is how git names a staged blob, and
	 * it goes through `cat-file` like any other revision. An empty revision string is a side that
	 * does not exist (an addition has no before, a deletion has no after) and reads back as null.
	 */
	const befores = await readBlobs(
		cwd,
		wanted.map(({ path, status }) => (status === "added" ? "" : `${head ? base : "HEAD"}:${path}`)),
	);
	const afters = await readBlobs(
		cwd,
		wanted.map(({ path, status }) => (status === "deleted" ? "" : head ? `${head}:${path}` : `:${path}`)),
	);

	const files: WorkspaceDiffFile[] = [];
	let added = 0;
	let removed = 0;

	wanted.forEach(({ path, status }, i) => {
		const before = textOf(befores[i], status === "added");
		const after = textOf(afters[i], status === "deleted");
		// Null means a blob too large to diff; the file is dropped rather than half-reported.
		if (before === null || after === null) return;
		// Counted from the diff itself rather than from `--numstat`, so the totals and the hunks
		// on screen can never disagree.
		const diff = computeDiff(before, after);
		added += diff.added;
		removed += diff.removed;
		files.push({ path, status, added: diff.added, removed: diff.removed, hunks: capHunks(diff.hunks) });
	});

	return { files, added, removed };
}

/**
 * One side of a comparison as text: empty when it does not exist, null when it is too large.
 *
 * The two used to be told apart by `blobAt` returning `""` for a missing object and `null` for an
 * oversized one, and the distinction is load-bearing: empty is a side of the diff, null drops the
 * file from the list entirely. `absent` says the caller already knows there is no such side, which
 * is not the same as git having failed to find one.
 */
function textOf(read: BlobRead | null, absent: boolean): string | null {
	if (absent || !read) return "";
	return read.content ? read.content.toString("utf8") : null;
}

/** A commit's own diff — against its parent, or against nothing if it is the first. */
export async function commitDiff(cwd: string, sha: string) {
	const parent = await git(cwd, ["rev-parse", "--verify", `${sha}^`])
		.then((out) => out.trim())
		.catch(() => EMPTY_TREE);
	return diffRefs(cwd, parent, sha);
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
