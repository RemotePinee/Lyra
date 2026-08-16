/**
 * Where a conversation about a pull request happens, given that it happens nowhere.
 *
 * A review is of someone else's branch, in a repository this machine may never have cloned — most
 * of the list is other people's projects. So the usual answer to "which directory is this session
 * in" does not exist here, and forcing one would be a lie: pointing the agent at whatever project
 * happened to be open would give it a working tree that has nothing to do with the diff on screen.
 *
 * Instead each pull request gets a scratch directory of its own under the app's home. Nothing is
 * expected to be in it. It is somewhere to put a patch, a note, a checkout if the conversation
 * goes that way — and, more importantly, it is a stable identity: sessions are stored by a hash of
 * their directory, so the same pull request comes back to the same conversation next time, months
 * later, without anything having to be recorded on the side.
 *
 * The path is derived, never taken from the API. A repository name arrives from GitHub as
 * `owner/name` and could in principle carry anything else; this is a filesystem path being built
 * from remote input, so every character outside a safe set is replaced rather than trusted.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lyraHome } from "@lyra/core";

/** Everything outside this becomes a dash, which also flattens `owner/name` into one segment. */
const UNSAFE = /[^a-zA-Z0-9._-]+/g;

/**
 * A short, stable, unambiguous folder name for one pull request.
 *
 * Bounded because a repository name has no length limit worth relying on and a path component
 * does. Truncation could in principle collide, which is why the number is appended after it: two
 * repositories that truncate alike still differ by their pull request number in almost every case,
 * and the worst outcome — two reviews sharing one scratch directory — costs a mixed transcript,
 * not data.
 */
export function prChatSlug(repo: string, number: number): string {
	const safe =
		repo
			/*
			 * Runs of dots collapse before anything else.
			 *
			 * A dot has to stay in the safe set — plenty of repositories are named `something.js` —
			 * but that also lets `..` through, and replacing the separators around it leaves a
			 * `..` segment sitting in a path built from remote input. It cannot traverse anything
			 * as this is used today, since it ends up as one component of a path we join ourselves.
			 * It is removed anyway: the next person to reuse this for a nested path should not have
			 * to notice that it was only safe by circumstance.
			 */
			.replace(/\.{2,}/g, ".")
			.replace(UNSAFE, "-")
			// Leading dots hide the directory; leading or trailing dashes are just noise.
			.replace(/^[-.]+|[-.]+$/g, "")
			.slice(0, 60) || "repo";
	return `${safe}-${number}`;
}

/**
 * The directory every pull request conversation lives under.
 *
 * Exposed so the renderer can recognise these sessions and keep them out of the sidebar. They are
 * real sessions in a real directory — that is what makes them reopen months later — but they are
 * not projects, and listing a folder called `owner-repo-6381` between someone's actual work is
 * noise. Derived here rather than pattern-matched there: the home is `LYRA_HOME`-overridable, so
 * a hard-coded `.lyra/pr` in the renderer would be wrong for anyone who moved it.
 */
export function prChatRoot(): string {
	return join(lyraHome(), "pr");
}

/** The scratch directory for this pull request, created if it is not there yet. */
export async function prChatDir(repo: string, number: number): Promise<string> {
	const dir = join(lyraHome(), "pr", prChatSlug(repo, number));
	await mkdir(dir, { recursive: true });
	return dir;
}

export interface PrBrief {
	repo: string;
	number: number;
	title: string;
	author: string;
	url: string;
	headRefName: string;
	baseRefName: string;
	state: string;
	body: string;
}

/**
 * Leave the facts of the pull request in the directory the conversation runs in.
 *
 * The alternative was pasting all of it into the first question, which puts the description of
 * somebody else's change above what the user actually asked and spends the same tokens on every
 * new conversation. A file is there when wanted and costs nothing when not — and it is the
 * obvious thing for an agent to find in an otherwise empty working directory.
 *
 * Deliberately not the diff. Those run to megabytes, they are the part most likely to be stale by
 * the time anyone reads it, and `gh pr diff` fetches the current one on demand.
 */
export async function writePrBrief(dir: string, pr: PrBrief): Promise<void> {
	const lines = [
		`# ${pr.title}`,
		"",
		`- 仓库：${pr.repo}`,
		`- 编号：#${pr.number}`,
		`- 作者：${pr.author}`,
		`- 分支：${pr.headRefName} → ${pr.baseRefName}`,
		`- 状态：${pr.state}`,
		`- 链接：${pr.url}`,
		"",
		"拿到改动：",
		"",
		"```sh",
		`gh pr diff ${pr.number} --repo ${pr.repo}`,
		"```",
		"",
		"## 描述",
		"",
		pr.body.trim() || "（作者没有写描述）",
		"",
	];
	await writeFile(join(dir, "PR.md"), lines.join("\n"), "utf8");
}
