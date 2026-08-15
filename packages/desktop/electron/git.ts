/**
 * Branches, and the door to everything else git-related.
 *
 * Branch operations live here because they are what the panel opens on. The rest — status, diffs,
 * history, repositories — is re-exported from the modules that own it, so a caller says
 * `from "./git.ts"` and does not have to know which file a function moved to.
 */

import { basename, join } from "node:path";
import { git } from "./git-exec.ts";

export { git, run } from "./git-exec.ts";
export { collectWorkspaceDiff } from "./git-diff.ts";
export {
	commentOnPullRequest,
	listMyPullRequests,
	pullRequestDetail,
	pullRequestDiff,
	reviewPullRequest,
	type ReviewVerdict,
} from "./git-pr.ts";
export {
	commitAll,
	discardPaths,
	gitStatus,
	stagePaths,
	unstagePaths,
	workspaceStat,
	type GitCommit,
	type GitStatus,
	type GitStatusFile,
} from "./git-status.ts";
export {
	commitDiff,
	commitStaged,
	createBranch,
	deleteBranch,
	diffRefs,
	gitLog,
	pullBranch,
	pushBranch,
} from "./git-history.ts";
export { addWorktree, initRepo, listRepos, listWorktrees, type RepoRef } from "./git-repos.ts";

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
