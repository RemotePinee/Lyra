import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
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
	const named = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
		.then((out) => out.trim())
		.catch(() => null);
	if (named) return named;
	/*
	 * A repository with no commits yet still has a branch — it just has nothing to point at.
	 *
	 * `rev-parse HEAD` resolves a commit and so fails outright there, which showed a freshly
	 * initialised project as having no branch at all. `symbolic-ref` reads the name HEAD is
	 * waiting to become, which is what the first commit will land on.
	 */
	return git(cwd, ["symbolic-ref", "--short", "HEAD"])
		.then((out) => out.trim() || null)
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

/* ---------------------------------------------------------------------------
 * The Git panel's surface.
 *
 * Everything above this line serves the composer's status bar, which asks one question: how
 * much is uncommitted. A panel asks the questions you act on — what exactly changed, what is
 * staged, what happened before this, how does this branch differ from that one — and each of
 * those is a different git plumbing call.
 * ------------------------------------------------------------------------- */

/** The empty tree, so the first commit in a repository can be diffed against something. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface GitStatusFile {
	path: string;
	status: WorkspaceDiffFile["status"];
	/** Both can be true: a file edited after part of it was staged. */
	staged: boolean;
	unstaged: boolean;
	added: number;
	removed: number;
}

export interface GitStatus {
	branch: string | null;
	upstream: string | null;
	/** Commits this branch has that its upstream does not, and the reverse. */
	ahead: number;
	behind: number;
	staged: GitStatusFile[];
	unstaged: GitStatusFile[];
}

/**
 * Status split by index, which the porcelain format already encodes.
 *
 * Each entry's first character is the index state and the second the working-tree state, so a
 * file can appear on both sides — staged as far as it was added, unstaged for what came after.
 * Presenting that as one list is what makes people commit half of what they meant to.
 */
export async function gitStatus(cwd: string): Promise<GitStatus> {
	const empty: GitStatus = { branch: null, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [] };
	if (!(await isGitRepo(cwd))) return empty;

	const [branch, porcelain] = await Promise.all([
		gitBranch(cwd),
		git(cwd, ["status", "--porcelain=v1", "-uall", "-z", "--branch"]).catch(() => ""),
	]);

	const parts = porcelain.split("\0").filter(Boolean);
	const header = parts[0]?.startsWith("## ") ? parts.shift()!.slice(3) : "";
	const upstreamMatch = header.match(/\.\.\.(\S+)/);
	const aheadMatch = header.match(/ahead (\d+)/);
	const behindMatch = header.match(/behind (\d+)/);

	const [stagedStat, unstagedStat] = await Promise.all([
		numstat(cwd, ["diff", "--numstat", "--cached"]),
		numstat(cwd, ["diff", "--numstat"]),
	]);

	const staged: GitStatusFile[] = [];
	const unstaged: GitStatusFile[] = [];

	for (const entry of parts.slice(0, MAX_FILES)) {
		const index = entry[0];
		const tree = entry[1];
		// A rename's porcelain entry carries both paths separated by a NUL, already split above.
		const path = entry.slice(3);
		if (!path) continue;

		if (index && index !== " " && index !== "?") {
			staged.push({
				path,
				status: classify(index),
				staged: true,
				unstaged: false,
				...(stagedStat.get(path) ?? { added: 0, removed: 0 }),
			});
		}
		if (tree && tree !== " ") {
			const untracked = index === "?" || tree === "?";
				unstaged.push({
				path,
				status: untracked ? "untracked" : classify(tree),
				staged: false,
				unstaged: true,
				...(untracked ? await countNewFile(cwd, path) : (unstagedStat.get(path) ?? { added: 0, removed: 0 })),
			});
		}
	}

	return {
		branch,
		upstream: upstreamMatch?.[1] ?? null,
		ahead: Number.parseInt(aheadMatch?.[1] ?? "0", 10),
		behind: Number.parseInt(behindMatch?.[1] ?? "0", 10),
		staged,
		unstaged,
	};
}

async function numstat(cwd: string, args: string[]): Promise<Map<string, { added: number; removed: number }>> {
	const out = await git(cwd, args).catch(() => "");
	const map = new Map<string, { added: number; removed: number }>();
	for (const line of out.split("\n")) {
		if (!line.trim()) continue;
		const [plus, minus, path] = line.split("\t");
		if (path) map.set(path, { added: Number.parseInt(plus, 10) || 0, removed: Number.parseInt(minus, 10) || 0 });
	}
	return map;
}

/** An untracked file has no other side to diff against, so every line counts as added. */
async function countNewFile(cwd: string, path: string): Promise<{ added: number; removed: number }> {
	const buffer = await readFile(join(cwd, path)).catch(() => null);
	if (!buffer || buffer.length > MAX_BLOB_BYTES || buffer.includes(0)) return { added: 0, removed: 0 };
	const text = buffer.toString("utf8");
	return { added: text.length === 0 ? 0 : text.replace(/\n$/, "").split("\n").length, removed: 0 };
}

export async function stagePaths(cwd: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
	return run(cwd, ["add", "--", ...paths]);
}

export async function unstagePaths(cwd: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
	// `restore --staged` rather than `reset`: it leaves the working tree alone even before the
	// first commit exists, where `reset HEAD` has nothing to reset against.
	return run(cwd, ["restore", "--staged", "--", ...paths]);
}

/**
 * Throw away working-tree changes.
 *
 * Untracked files are deleted rather than restored — there is no version to restore them to.
 * The two are done in separate calls because `restore` refuses paths it does not track.
 */
export async function discardPaths(cwd: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
	const tracked: string[] = [];
	const untracked: string[] = [];
	for (const path of paths) {
		const known = await git(cwd, ["ls-files", "--error-unmatch", "--", path]).then(() => true).catch(() => false);
		(known ? tracked : untracked).push(path);
	}
	if (tracked.length) {
		const result = await run(cwd, ["restore", "--worktree", "--", ...tracked]);
		if (!result.ok) return result;
	}
	if (untracked.length) return run(cwd, ["clean", "-fd", "--", ...untracked]);
	return { ok: true };
}

export interface GitCommit {
	sha: string;
	shortSha: string;
	subject: string;
	/** Every parent, so the renderer can draw where lines split and rejoin. */
	parents: string[];
	author: string;
	/** ISO 8601, formatted for display in the renderer where the locale lives. */
	date: string;
	/** Branch and tag names pointing at this commit, already stripped of their prefixes. */
	refs: string[];
}

const LOG_FORMAT = "%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%D%x1f%P%x1e";

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

/** Runs a git command for its effect, turning failure into readable text rather than a throw. */
async function run(cwd: string, args: string[]): Promise<{ ok: boolean; error?: string }> {
	try {
		await git(cwd, args);
		return { ok: true };
	} catch (error) {
		const detail = error as { stderr?: string; stdout?: string; message?: string };
		const text = (detail.stderr || detail.stdout || detail.message || "").trim();
		return { ok: false, error: text.split("\n").slice(0, 3).join("\n") || "操作失败" };
	}
}

export interface RepoRef {
	/** Absolute path to the working directory of this repository. */
	path: string;
	/** Path relative to the workspace, or the folder name for the workspace root itself. */
	label: string;
	branch: string | null;
	/** True when this is a linked worktree rather than the main checkout. */
	worktree: boolean;
}

/** Directories never worth descending into when looking for repositories. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "build", "target", "vendor", ".next", ".venv"]);

/**
 * Every git repository under the workspace, not just the workspace itself.
 *
 * A workspace is a folder someone opened, and plenty of people keep several repositories side
 * by side in one — a frontend and a backend, or a set of services versioned apart on purpose.
 * With one repository assumed, the panel showed whichever one happened to be at the root and
 * silently ignored the rest.
 *
 * Two levels deep, because that covers the layouts people actually use (`~/work/*`, `repo/*`)
 * and stops the scan from walking an entire home directory.
 */
export async function listRepos(root: string): Promise<RepoRef[]> {
	const found: RepoRef[] = [];

	if (await isGitRepo(root)) {
		found.push({ path: root, label: basename(root), branch: await gitBranch(root), worktree: false });
	}

	const walk = async (dir: string, depth: number) => {
		if (depth > 2 || found.length >= 24) return;
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
			const child = join(dir, entry.name);
			// `.git` can be a directory (a normal clone) or a file (a linked worktree).
			const isRepo = await stat(join(child, ".git")).then(() => true).catch(() => false);
			if (isRepo) {
				if (!found.some((repo) => repo.path === child)) {
					found.push({
						path: child,
						label: relative(root, child) || basename(child),
						branch: await gitBranch(child),
						worktree: false,
					});
				}
				// A repository's own subdirectories are its business, not ours.
				continue;
			}
			await walk(child, depth + 1);
		}
	};
	await walk(root, 1);

	return found;
}

/**
 * The worktrees attached to a repository.
 *
 * A worktree is a second checkout of the same repository on a different branch, which is how
 * people keep a review and their own work open at once. They share one history, so the panel
 * treats them as places to switch to rather than as separate repositories.
 */
export async function listWorktrees(cwd: string): Promise<RepoRef[]> {
	if (!(await isGitRepo(cwd))) return [];
	const out = await git(cwd, ["worktree", "list", "--porcelain"]).catch(() => "");
	const trees: RepoRef[] = [];
	let path: string | null = null;
	let branch: string | null = null;

	const flush = (isMain: boolean) => {
		if (!path) return;
		trees.push({ path, label: basename(path), branch, worktree: !isMain });
		path = null;
		branch = null;
	};

	for (const line of out.split("\n")) {
		if (line.startsWith("worktree ")) {
			flush(trees.length === 0);
			path = line.slice("worktree ".length);
		} else if (line.startsWith("branch ")) {
			branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
		} else if (line.startsWith("detached")) {
			branch = null;
		}
	}
	flush(trees.length === 0);

	// The first entry is the main checkout; the rest are the linked ones.
	return trees.map((tree, index) => ({ ...tree, worktree: index > 0 }));
}

export async function addWorktree(cwd: string, branch: string): Promise<{ ok: boolean; path?: string; error?: string }> {
	return createWorktree(cwd, branch);
}

/**
 * Turn a plain directory into a repository.
 *
 * Offered because the panel is often looking at a project that was just created — by the agent,
 * a minute ago — and "not a repository" is a state with an obvious next step rather than a dead
 * end. Nothing is committed: the first commit is a decision, and the panel is right there for it.
 */
export async function initRepo(cwd: string): Promise<{ ok: boolean; error?: string }> {
	if (await isGitRepo(cwd)) return { ok: true };
	try {
		await git(cwd, ["init"]);
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
