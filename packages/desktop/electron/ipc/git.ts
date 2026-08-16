/**
 * Git over IPC.
 *
 * Thin on purpose: every handler here is a name, a guard and a call into `../git.ts`. The work is
 * there; what belongs at this layer is only the decision about which requests are allowed to reach
 * it — the renderer can name any path, and a repository the user never opened is not one of them.
 */

import { ipcMain } from "electron";
import { githubAvatar } from "../avatars.ts";
import { findLocalCheckout } from "../git-remote.ts";
import { generalScratchDir, type PrBrief, prScratchDir, scratchRoots, writePrBrief } from "../scratch.ts";
import {
	collectWorkspaceDiff,
	commitAll,
	commitDiff,
	commitStaged,
	createBranch,
	createWorktree,
	deleteBranch,
	diffRefs,
	gitLog,
	gitStatus,
	initRepo,
	listBranches,
	listRepos,
	listWorktrees,
	pullBranch,
	pushBranch,
	stagePaths,
	switchBranch,
	discardPaths,
	unstagePaths,
	workspaceStat,
} from "../git.ts";
import {
	commentOnPullRequest,
	listMyPullRequests,
	pullRequestDetail,
	pullRequestDiff,
	reviewPullRequest,
	type ReviewVerdict,
} from "../git-pr.ts";

export interface GitIpcDeps {
	/** Whether a path lies inside a project the user has opened. */
	insideAProject(target: string): boolean;
}

export function registerGitIpc({ insideAProject }: GitIpcDeps): void {
	ipcMain.handle("git:myPullRequests", async () => listMyPullRequests());

	ipcMain.handle("git:pullRequest", async (_event, repo: string, number: number) => pullRequestDetail(repo, number));

	ipcMain.handle("git:pullRequestDiff", async (_event, repo: string, number: number) => pullRequestDiff(repo, number));

	ipcMain.handle("git:commentOnPullRequest", async (_event, repo: string, number: number, body: string) =>
		commentOnPullRequest(repo, number, body),
	);

	ipcMain.handle(
		"git:reviewPullRequest",
		async (_event, repo: string, number: number, verdict: ReviewVerdict, body: string) =>
			reviewPullRequest(repo, number, verdict, body),
	);

	ipcMain.handle("git:branches", async (_event, cwd: string) => listBranches(cwd));

	ipcMain.handle("git:switchBranch", async (_event, cwd: string, branch: string) => switchBranch(cwd, branch));

	ipcMain.handle("git:createWorktree", async (_event, cwd: string, branch: string) => createWorktree(cwd, branch));

	ipcMain.handle("git:stat", async (_event, cwd: string) => workspaceStat(cwd));

	ipcMain.handle("git:commit", async (_event, cwd: string, message: string) => {
		// Same boundary as reading and writing files. Committing is the most consequential thing
		// the renderer can ask for — it stages everything under a directory — so it is the last
		// place to leave unchecked.
		if (!insideAProject(cwd)) return { ok: false, error: "该目录不在已打开的项目内" };
		return commitAll(cwd, message);
	});

	ipcMain.handle("git:repos", async (_event, root: string) => listRepos(root));

	ipcMain.handle("git:worktrees", async (_event, cwd: string) => listWorktrees(cwd));
	ipcMain.handle("git:init", async (_event, cwd: string) => initRepo(cwd));

	ipcMain.handle("git:status", async (_event, cwd: string) => gitStatus(cwd));

	ipcMain.handle("git:log", async (_event, cwd: string, limit?: number, ref?: string) => gitLog(cwd, limit, ref));

	ipcMain.handle("git:commitDiff", async (_event, cwd: string, sha: string) => commitDiff(cwd, sha));

	ipcMain.handle("git:diffRefs", async (_event, cwd: string, base: string, head: string | null) =>
		diffRefs(cwd, base, head),
	);

	/*
	 * The writing half, behind the same boundary as committing.
	 *
	 * Staging, discarding and branch surgery all reach outside the renderer's sandbox and are
	 * hard or impossible to undo — `discard` in particular deletes untracked files outright.
	 */
	for (const [channel, action] of [
		["git:stage", stagePaths],
		["git:unstage", unstagePaths],
		["git:discard", discardPaths],
	] as const) {
		ipcMain.handle(channel, async (_event, cwd: string, paths: string[]) => {
			if (!insideAProject(cwd)) return { ok: false, error: "该目录不在已打开的项目内" };
			return action(cwd, paths);
		});
	}

	ipcMain.handle("git:commitStaged", async (_event, cwd: string, message: string) => {
		if (!insideAProject(cwd)) return { ok: false, error: "该目录不在已打开的项目内" };
		return commitStaged(cwd, message);
	});

	ipcMain.handle("git:createBranch", async (_event, cwd: string, name: string, from?: string) => {
		if (!insideAProject(cwd)) return { ok: false, error: "该目录不在已打开的项目内" };
		return createBranch(cwd, name, from);
	});

	ipcMain.handle("git:deleteBranch", async (_event, cwd: string, name: string, force?: boolean) => {
		if (!insideAProject(cwd)) return { ok: false, error: "该目录不在已打开的项目内" };
		return deleteBranch(cwd, name, force);
	});

	ipcMain.handle("git:push", async (_event, cwd: string) => {
		if (!insideAProject(cwd)) return { ok: false, error: "该目录不在已打开的项目内" };
		return pushBranch(cwd);
	});

	ipcMain.handle("git:pull", async (_event, cwd: string) => {
		if (!insideAProject(cwd)) return { ok: false, error: "该目录不在已打开的项目内" };
		return pullBranch(cwd);
	});

	ipcMain.handle("diff:workspace", async (_event, cwd: string) => collectWorkspaceDiff(cwd));

	/*
	 * The scratch directory a pull request's conversation lives in.
	 *
	 * Here rather than in the renderer because it has to exist on disk before a session can be
	 * created in it, and because the app's home is the main process's to know. Returning the path
	 * lets the renderer use the ordinary session IPC for everything after this — a review chat is
	 * a normal session that simply is not in a project.
	 */
	ipcMain.handle("scratch:roots", async () => scratchRoots());

	/*
	 * The scratch directory for a conversation about this pull request, with the facts left in it.
	 *
	 * Only reached when the repository is not among the user's projects. `PR.md` is refreshed each
	 * time: a description edited on GitHub should not go on being answered from a copy taken weeks
	 * ago.
	 */
	ipcMain.handle("scratch:forPullRequest", async (_event, pr: PrBrief) => {
		const dir = await prScratchDir(pr.repo, pr.number);
		await writePrBrief(dir, pr).catch(() => {});
		return dir;
	});

	ipcMain.handle("scratch:general", async () => generalScratchDir());

	/*
	 * An avatar as a data URL, so the renderer never reaches out to github.com itself.
	 *
	 * Keeping the page's CSP narrow is worth one IPC round trip: widening `img-src` for a 20pt
	 * circle would widen it for every rendered comment body too.
	 */
	ipcMain.handle("git:avatar", async (_event, login: string) => githubAvatar(login));

	/*
	 * Which of the user's own projects is this repository, if any.
	 *
	 * Deliberately only their project list — not a scan of the disk. A checkout the user has never
	 * added is not somewhere the app should start working in unasked, and "not in the list" is the
	 * answer that sends this to a project-less conversation, which is the honest outcome.
	 */
	ipcMain.handle("git:findLocalCheckout", async (_event, repo: string, candidates: string[]) =>
		findLocalCheckout(repo, candidates),
	);
}
