/**
 * Reading a directory as a project.
 *
 * Its name, whether it is a repository, what has changed in it, and which repositories are nested
 * inside — a monorepo with three checkouts is one workspace with three repos, not three workspaces.
 */

import { existsSync } from "node:fs";
import { collectWorkspaceDiff, gitBranch, isGitRepo } from "./git.ts";
import type { WorkspaceInfo } from "./ipc-types.ts";

export async function workspaceInfo(path: string): Promise<WorkspaceInfo | null> {
	if (!existsSync(path)) return null;
	const git = await isGitRepo(path);
	const diff = git ? await collectWorkspaceDiff(path) : { added: 0, removed: 0, branch: null, files: [] };
	return {
		path,
		// oxlint-disable-next-line unicorn/prefer-array-find -- `pop` takes the last segment, not the first
		name: path.split("/").filter(Boolean).pop() ?? path,
		isGitRepo: git,
		branch: git ? await gitBranch(path) : null,
		added: diff.added,
		removed: diff.removed,
	};
}
