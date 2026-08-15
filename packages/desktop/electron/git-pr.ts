/**
 * Pull requests, via the GitHub CLI.
 *
 * Only through `gh`, and only if the user already has it authenticated — asking for a token would
 * make this a credential store, which it has no business being.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
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


const execFileAsync = promisify(execFile);

import { isGitRepo } from "./git.ts";

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
