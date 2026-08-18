/**
 * Reading a repository URL, which every part of the system has to do for a different reason.
 *
 * The worker needs `owner/repo` to ask GitHub for a tarball, the site needs it to link somewhere,
 * and the app needs it to show where a bundle came from. Three parsers would be three chances to
 * disagree about `git@github.com:o/r.git`, so there is one.
 *
 * Only GitHub is understood, and that is a deliberate limit rather than an oversight: the fetch
 * path is built on GitHub's tarball endpoint, so a GitLab URL that parsed here would produce an
 * entry that cannot be built. Better to refuse it at submission with a sentence than to accept it
 * and fail in a queue.
 */

export interface RepoRef {
	owner: string;
	repo: string;
	/** Canonical https form, whatever form it arrived in. */
	url: string;
	/** Where a person should be sent. Same as `url` for GitHub, and that is the point of having it. */
	homepage: string;
}

const GITHUB_PATTERNS = [
	/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
	/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
	/^github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
	/^([\w.-]+)\/([\w.-]+)$/,
];

/** Parse a repository reference, or null when it is not a GitHub one we can fetch from. */
export function parseRepo(raw: string): RepoRef | null {
	const trimmed = raw?.trim();
	if (!trimmed) return null;

	for (const pattern of GITHUB_PATTERNS) {
		const match = pattern.exec(trimmed);
		if (!match) continue;
		const owner = match[1];
		const repo = match[2];
		// A path segment that is not a name — `..` in a URL we are about to build is worth refusing.
		if (!isSegment(owner) || !isSegment(repo)) return null;
		const url = `https://github.com/${owner}/${repo}`;
		return { owner, repo, url: `${url}.git`, homepage: url };
	}
	return null;
}

/**
 * GitHub's tarball for a ref.
 *
 * `codeload` rather than the API's `/tarball` redirect: one request instead of two, and it does not
 * spend the API rate limit, which on a shared Cloudflare egress IP is the scarcer of the two.
 */
export function tarballUrl(ref: RepoRef, gitRef: string): string {
	return `https://codeload.github.com/${ref.owner}/${ref.repo}/tar.gz/${encodeURIComponent(gitRef)}`;
}

/** The owner's avatar, which every GitHub project has and which never 404s. */
export function ownerAvatar(ref: RepoRef, size = 128): string {
	return `https://github.com/${ref.owner}.png?size=${size}`;
}

/**
 * A sub-path inside a repository, or null for anything absolute or climbing out of the checkout.
 *
 * Shared with the app's installer for one reason: the check that a path cannot escape has to give
 * the same answer on both sides. A path the platform accepted and the client rejected would be an
 * entry that installs nowhere; the reverse would be worse.
 */
export function normalisePath(raw: string | undefined): string | null {
	if (raw === undefined || raw === "") return "";
	const trimmed = raw.replace(/^\/+|\/+$/g, "");
	if (!trimmed) return "";
	const parts = trimmed.split("/");
	if (parts.some((part) => part === ".." || part === "." || part === "")) return null;
	return parts.join("/");
}

function isSegment(value: string): boolean {
	return /^[\w.-]+$/.test(value) && !value.includes("..");
}
