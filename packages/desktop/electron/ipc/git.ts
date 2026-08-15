/**
 * Git over IPC.
 *
 * Thin on purpose: every handler here is a name, a guard and a call into `../git.ts`. The work is
 * there; what belongs at this layer is only the decision about which requests are allowed to reach
 * it — the renderer can name any path, and a repository the user never opened is not one of them.
 */

import { ipcMain } from "electron";
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
	listPullRequests,
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

export interface GitIpcDeps {
	/** Whether a path lies inside a project the user has opened. */
	insideAProject(target: string): boolean;
}

export function registerGitIpc({ insideAProject }: GitIpcDeps): void {
	ipcMain.handle("git:pullRequests", async (_event, cwd: string) => listPullRequests(cwd));

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
}
