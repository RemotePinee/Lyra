import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { computeDiff, type DiffHunk } from "@deepwise/core";
import type { WorkspaceDiffFile } from "./ipc-types.ts";

const execFileAsync = promisify(execFile);
const MAX_FILES = 200;
const MAX_BLOB_BYTES = 400_000;

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
	return stdout;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
	return git(cwd, ["rev-parse", "--is-inside-work-tree"])
		.then((out) => out.trim() === "true")
		.catch(() => false);
}

export async function gitBranch(cwd: string): Promise<string | null> {
	return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
		.then((out) => out.trim())
		.catch(() => null);
}

export interface BranchList {
	current: string | null;
	local: string[];
	/** Remote-tracking branches, minus the ones that already have a local counterpart. */
	remote: string[];
}

/** Local and remote branches, for the switcher in the composer. */
export async function listBranches(cwd: string): Promise<BranchList> {
	if (!(await isGitRepo(cwd))) return { current: null, local: [], remote: [] };

	const [current, refs] = await Promise.all([
		gitBranch(cwd),
		git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"]).catch(() => ""),
	]);

	const local: string[] = [];
	const remote: string[] = [];
	for (const line of refs.split("\n")) {
		const name = line.trim();
		// `origin/HEAD` is a symbolic pointer, not somewhere you can check out.
		if (!name || name.endsWith("/HEAD")) continue;
		if (name.includes("/")) remote.push(name);
		else local.push(name);
	}

	const known = new Set(local);
	return {
		current,
		local: local.sort(),
		// A remote branch whose short name already exists locally would just check out the local one.
		remote: remote.filter((r) => !known.has(r.split("/").slice(1).join("/"))).sort(),
	};
}

/**
 * Switch branches, refusing rather than clobbering.
 *
 * `git switch` stops on its own when uncommitted work would be overwritten; the message it
 * prints is more useful than anything this layer could invent, so it is passed straight
 * through to the user.
 */
export async function switchBranch(cwd: string, branch: string): Promise<{ ok: boolean; error?: string }> {
	try {
		await git(cwd, ["switch", branch]);
		return { ok: true };
	} catch (cause) {
		const message = cause instanceof Error && "stderr" in cause ? String(cause.stderr) : String(cause);
		return { ok: false, error: message.trim() || "切换分支失败" };
	}
}

/**
 * Create a git worktree beside the repository.
 *
 * A worktree gets its own directory and its own branch, so an agent can work on one task
 * without disturbing whatever is checked out in the main tree. It is placed as a sibling —
 * inside the repo it would show up as an untracked directory in every diff.
 */
export async function createWorktree(
	cwd: string,
	branch: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
	if (!(await isGitRepo(cwd))) return { ok: false, error: "当前项目不是 Git 仓库" };

	const safe = branch.trim().replace(/[^\w.\-/]/g, "-");
	if (!safe) return { ok: false, error: "分支名不能为空" };

	const root = await git(cwd, ["rev-parse", "--show-toplevel"])
		.then((out) => out.trim())
		.catch(() => cwd);
	const target = join(root, "..", `${basename(root)}-${safe.replace(/\//g, "-")}`);

	try {
		// `-B` so re-running with the same name resets rather than failing on "already exists".
		await git(cwd, ["worktree", "add", "-B", safe, target]);
		return { ok: true, path: target };
	} catch (cause) {
		const message = cause instanceof Error && "stderr" in cause ? String(cause.stderr) : String(cause);
		return { ok: false, error: message.trim() || "创建工作树失败" };
	}
}

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

function classify(code: string): WorkspaceDiffFile["status"] {
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
function capHunks(hunks: DiffHunk[]): DiffHunk[] {
	return hunks.slice(0, 40);
}

export interface PullRequest {
	number: number;
	title: string;
	author: string;
	state: string;
	isDraft: boolean;
	url: string;
	updatedAt: string;
	additions: number;
	deletions: number;
	headRefName: string;
}

/**
 * List open pull requests via the `gh` CLI.
 *
 * Shelling out to `gh` rather than talking to the API directly means the user's existing
 * login is reused — no token to store, and private repos work without extra setup.
 */
export async function listPullRequests(cwd: string): Promise<{ pullRequests: PullRequest[]; error?: string }> {
	if (!(await isGitRepo(cwd))) return { pullRequests: [], error: "当前项目不是 Git 仓库" };

	try {
		const { stdout } = await execFileAsync(
			"gh",
			[
				"pr",
				"list",
				"--limit",
				"30",
				"--json",
				"number,title,author,state,isDraft,url,updatedAt,additions,deletions,headRefName",
			],
			{ cwd, maxBuffer: 8 * 1024 * 1024 },
		);
		const raw = JSON.parse(stdout) as (Omit<PullRequest, "author"> & { author?: { login?: string } })[];
		return {
			pullRequests: raw.map((pr) => ({ ...pr, author: pr.author?.login ?? "unknown" })),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("ENOENT")) return { pullRequests: [], error: "未安装 gh CLI（brew install gh）" };
		if (message.includes("not logged") || message.includes("authentication")) {
			return { pullRequests: [], error: "gh 未登录，请先运行 gh auth login" };
		}
		if (message.includes("no git remote") || message.includes("not a git repository")) {
			return { pullRequests: [], error: "当前仓库没有关联 GitHub 远端" };
		}
		return { pullRequests: [], error: message.split("\n")[0].slice(0, 200) };
	}
}

/**
 * How much is uncommitted, without building the diffs.
 *
 * The change bar shows this continuously, so it has to be cheap: `collectWorkspaceDiff` reads
 * every changed file twice and computes hunks, which is right for a panel you opened and wrong
 * for a number that sits on screen all session.
 *
 * Counted the way the review panel counts, because the two are read together — the bar says
 * 34k and the panel it opens says 10k, and one of them is now a lie. Both skip blobs over
 * `MAX_BLOB_BYTES`: a 400KB generated lockfile is a change nobody is going to read line by
 * line, and the panel already declines to diff it.
 *
 * Tracked files come from `--numstat`; untracked ones count as entirely new, which is what
 * they are. A repository with no commits yet has no HEAD to diff against — there, everything
 * is untracked.
 */
export async function workspaceStat(
	cwd: string,
): Promise<{ branch: string | null; added: number; removed: number; files: number }> {
	if (!(await isGitRepo(cwd))) return { branch: null, added: 0, removed: 0, files: 0 };

	const branch = await gitBranch(cwd);
	/*
	 * The same list the panel walks, truncated at the same point.
	 *
	 * Counting from a different enumeration is how the bar came to say 34k while the panel it
	 * opens said 10k. Both now start from `status -uall` and stop at `MAX_FILES`, so the number
	 * on the bar is a promise about what you will find inside.
	 */
	const status = await git(cwd, ["status", "--porcelain=v1", "-uall", "-z"]).catch(() => "");
	const entries = status.split("\0").filter(Boolean).slice(0, MAX_FILES);

	// One `--numstat` for every tracked change, rather than a git call per file.
	const tracked = new Map<string, { added: number; removed: number }>();
	const hasHead = await git(cwd, ["rev-parse", "--verify", "HEAD"]).then(() => true).catch(() => false);
	if (hasHead) {
		const numstat = await git(cwd, ["diff", "--numstat", "HEAD"]).catch(() => "");
		for (const line of numstat.split("\n")) {
			if (!line.trim()) continue;
			const [plus, minus, path] = line.split("\t");
			// Binary files report "-" for both counts; they change, but not by a line count.
			if (path) tracked.set(path, { added: Number.parseInt(plus, 10) || 0, removed: Number.parseInt(minus, 10) || 0 });
		}
	}

	let added = 0;
	let removed = 0;

	for (const entry of entries) {
		const path = entry.slice(3);
		if (!path) continue;

		const known = tracked.get(path);
		if (known) {
			added += known.added;
			removed += known.removed;
			continue;
		}

		// Untracked: every line is an addition. Skipped on the same terms the panel skips it.
		const buffer = await readFile(join(cwd, path)).catch(() => null);
		if (!buffer || buffer.length > MAX_BLOB_BYTES || buffer.includes(0)) continue;
		const text = buffer.toString("utf8");
		// A trailing newline does not make a further line.
		added += text.length === 0 ? 0 : text.replace(/\n$/, "").split("\n").length;
	}

	return { branch, added, removed, files: entries.length };
}

/**
 * Stage everything and commit it.
 *
 * `add -A` rather than committing only what is already staged: the agent's edits are never
 * staged, so a commit of the index alone would silently record nothing. What the bar counts is
 * what this commits — the number you looked at is the change you are approving.
 *
 * Failures come back as text rather than exceptions because they are usually actionable and
 * worth reading: an unset `user.email`, a pre-commit hook that rejected the change.
 */
export async function commitAll(cwd: string, message: string): Promise<{ ok: boolean; error?: string }> {
	const trimmed = message.trim();
	if (!trimmed) return { ok: false, error: "提交信息不能为空" };
	try {
		await git(cwd, ["add", "-A"]);
		await git(cwd, ["commit", "-m", trimmed]);
		return { ok: true };
	} catch (error) {
		const detail = error as { stderr?: string; stdout?: string; message?: string };
		const text = (detail.stderr || detail.stdout || detail.message || "").trim();
		return { ok: false, error: text.split("\n").slice(0, 3).join("\n") || "提交失败" };
	}
}
