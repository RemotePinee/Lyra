/**
 * Which local checkout, if any, is the repository this pull request is against.
 *
 * The point is that a review should land you where the code is. If the repository is already on
 * this machine, the conversation should start in it — with the files, the history and the branch
 * switcher all pointing at the right thing. If it is not, there is nothing to pretend about and
 * the conversation starts without a project at all.
 *
 * Matching is on the remote's `owner/name`, not on the directory name, because a checkout can be
 * called anything. A fork is deliberately not a match: `origin` is what this working copy pushes
 * to, and answering questions about someone else's branch from a directory that tracks a fork of
 * it would be quietly wrong in exactly the way that is hard to notice.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * `owner/name` from a remote URL, or null if it is not one we recognise.
 *
 * Both forms git hands out, plus the `ssh://` spelling that some hosts use:
 *
 *   git@github.com:owner/name.git
 *   https://github.com/owner/name.git
 *   ssh://git@github.com/owner/name
 *
 * Case is preserved but comparison is not — GitHub treats owner and repository names
 * case-insensitively, and a remote written in the other case is the same repository.
 */
export function repoFromRemote(url: string): string | null {
	const trimmed = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
	if (!trimmed) return null;

	// scp-like: host:owner/name, which is not a URL and cannot be parsed as one.
	const scp = /^[^/]+@[^:/]+:(.+)$/.exec(trimmed);
	const path = scp ? scp[1] : trimmed.replace(/^[a-z+]+:\/\/[^/]+\//i, "");
	if (path === trimmed && !scp) return null;

	const parts = path.split("/").filter(Boolean);
	if (parts.length < 2) return null;
	// The last two are owner and name; anything before is a hosting path (GitLab subgroups).
	return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/** The `origin` of a checkout, or null when there is none or it is not a repository. */
async function originOf(dir: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", dir, "remote", "get-url", "origin"], { timeout: 3000 });
		return repoFromRemote(stdout);
	} catch {
		return null;
	}
}

/**
 * The first of `candidates` whose `origin` is `repo`.
 *
 * Candidates are the user's own project list, so this is a handful of directories at most and
 * each answer is one cheap `git` call. Checked in the order given — the caller sorts by most
 * recently opened, which is the right tiebreaker when someone keeps two checkouts of one
 * repository.
 */
export async function findLocalCheckout(repo: string, candidates: string[]): Promise<string | null> {
	const want = repo.trim().toLowerCase();
	if (!want) return null;

	for (const dir of candidates) {
		const origin = await originOf(dir);
		if (origin && origin.toLowerCase() === want) return dir;
	}
	return null;
}
