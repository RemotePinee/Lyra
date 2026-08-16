/**
 * Pull requests, via the GitHub CLI.
 *
 * Only through `gh`, and only if the user already has it authenticated — asking for a token would
 * make this a credential store, which it has no business being.
 *
 * Scoped to the person, not to the folder that happens to be open. The pull requests that matter
 * on a Monday morning are the ones waiting on you and the ones you are waiting on, and those are
 * spread across every repository you work in — a list that only knows about the current checkout
 * answers a question nobody asked.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseUnifiedDiff } from "./diff-parse.ts";
import type {
	PullRequestCheck, PullRequestDetail, PullRequestSummary, WorkspaceDiffFile } from "./ipc-shapes.ts";

const execFileAsync = promisify(execFile);

/** Enough to see everything current without turning the list into an archive. */
const PER_BUCKET = 30;

/**
 * How a pull request relates to you, which is the only sensible way to group the list.
 *
 * `reviewing` is what is being asked of you now; `authored` is what you are waiting on; `reviewed`
 * is what you have already had a say in and may want to check back on. The order is the order of
 * urgency, and it decides which relation a pull request keeps when it qualifies for two.
 */
const BUCKETS = [
	{ relation: "reviewing", flag: "--review-requested=@me" },
	{ relation: "authored", flag: "--author=@me" },
	{ relation: "reviewed", flag: "--reviewed-by=@me" },
] as const;

const SEARCH_FIELDS = "number,title,author,repository,state,isDraft,url,createdAt,updatedAt,commentsCount";

export async function listMyPullRequests(): Promise<{ pullRequests: PullRequestSummary[]; error?: string }> {
	let buckets: PullRequestSummary[][];
	try {
		buckets = await Promise.all(
			BUCKETS.map(async ({ relation, flag }) => (await search(flag)).map((pr) => toSummary(pr, relation))),
		);
	} catch (error) {
		return { pullRequests: [], error: describe(error) };
	}

	// One row per pull request: the buckets overlap by design — your own can also be one you
	// reviewed — so the first bucket to claim it wins.
	const seen = new Map<string, PullRequestSummary>();
	for (const bucket of buckets) {
		for (const pr of bucket) {
			const key = `${pr.repo}#${pr.number}`;
			if (!seen.has(key)) seen.set(key, pr);
		}
	}

	return { pullRequests: [...seen.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
}

async function search(flag: string): Promise<RawSearchItem[]> {
	const { stdout } = await execFileAsync(
		"gh",
		["search", "prs", flag, "--state=open", "--limit", String(PER_BUCKET), "--json", SEARCH_FIELDS],
		{ maxBuffer: 8 * 1024 * 1024 },
	);
	return JSON.parse(stdout) as RawSearchItem[];
}

interface RawSearchItem {
	number: number;
	title: string;
	author?: { login?: string };
	repository?: { nameWithOwner?: string };
	state?: string;
	isDraft?: boolean;
	url: string;
	createdAt: string;
	updatedAt: string;
	commentsCount?: number;
}

function toSummary(pr: RawSearchItem, relation: PullRequestSummary["relation"]): PullRequestSummary {
	return {
		repo: pr.repository?.nameWithOwner ?? "",
		number: pr.number,
		title: pr.title,
		author: pr.author?.login ?? "unknown",
		state: (pr.state ?? "open").toUpperCase(),
		isDraft: pr.isDraft === true,
		url: pr.url,
		createdAt: pr.createdAt,
		updatedAt: pr.updatedAt,
		comments: pr.commentsCount ?? 0,
		relation,
		/*
		 * Not available from search, and deliberately not fetched to fill the list.
		 *
		 * Line counts need a `pr view` per row — thirty round trips to decorate a list nobody has
		 * clicked yet. They arrive with the detail, which is one request for the row you opened.
		 */
		additions: null,
		deletions: null,
		headRefName: null,
	};
}

const DETAIL_FIELDS = [
	"number",
	"title",
	"body",
	"author",
	"state",
	"isDraft",
	"url",
	"createdAt",
	"updatedAt",
	"additions",
	"deletions",
	"changedFiles",
	"headRefName",
	"baseRefName",
	"comments",
	"reviews",
	"reviewRequests",
	"statusCheckRollup",
	"commits",
	"mergeable",
	"labels",
].join(",");

export async function pullRequestDetail(
	repo: string,
	number: number,
): Promise<{ detail?: PullRequestDetail; error?: string }> {
	try {
		const { stdout } = await execFileAsync("gh", ["pr", "view", String(number), "--repo", repo, "--json", DETAIL_FIELDS], {
			maxBuffer: 16 * 1024 * 1024,
		});
		return { detail: toDetail(repo, JSON.parse(stdout) as RawDetail) };
	} catch (error) {
		return { error: describe(error) };
	}
}

interface RawDetail extends RawSearchItem {
	body?: string;
	additions?: number;
	deletions?: number;
	changedFiles?: number;
	headRefName?: string;
	baseRefName?: string;
	comments?: { author?: { login?: string }; body?: string; createdAt?: string }[];
	reviews?: { author?: { login?: string }; state?: string; body?: string; submittedAt?: string }[];
	reviewRequests?: { login?: string }[];
	statusCheckRollup?: { name?: string; state?: string; conclusion?: string; status?: string; detailsUrl?: string }[];
	commits?: {
		oid?: string;
		messageHeadline?: string;
		committedDate?: string;
		authors?: { login?: string; name?: string }[];
	}[];
	mergeable?: string;
	labels?: { name?: string }[];
}

function toDetail(repo: string, raw: RawDetail): PullRequestDetail {
	const reviews = (raw.reviews ?? []).map((review) => ({
		author: review.author?.login ?? "unknown",
		state: review.state ?? "COMMENTED",
		body: review.body ?? "",
		submittedAt: review.submittedAt ?? "",
	}));

	return {
		...toSummary({ ...raw, repository: { nameWithOwner: repo } }, "authored"),
		body: raw.body ?? "",
		additions: raw.additions ?? 0,
		deletions: raw.deletions ?? 0,
		changedFiles: raw.changedFiles ?? 0,
		headRefName: raw.headRefName ?? "",
		baseRefName: raw.baseRefName ?? "",
		comments: raw.comments?.length ?? 0,
		threads: (raw.comments ?? []).map((comment) => ({
			author: comment.author?.login ?? "unknown",
			body: comment.body ?? "",
			createdAt: comment.createdAt ?? "",
		})),
		reviews,
		/*
		 * Everyone whose opinion is outstanding or already given.
		 *
		 * Requested reviewers and past reviewers are two lists in the API and one question to a
		 * person: who is looking at this.
		 */
		reviewers: [
			...(raw.reviewRequests ?? []).map((r) => ({ login: r.login ?? "", state: "REQUESTED" })),
			...reviews.map((r) => ({ login: r.author, state: r.state })),
		].filter((r) => r.login),
		checks: summariseChecks(raw.statusCheckRollup),
		/*
		 * Commits, so the timeline can say what was pushed and not only what was said about it.
		 *
		 * Trimmed to what a row shows: headline, who, when, and a short sha. A commit's body belongs
		 * in the diff view — carrying it here would put a screen of text into a cache entry for a
		 * line nobody expanded.
		 */
		commits: (raw.commits ?? []).map((commit) => ({
			sha: (commit.oid ?? "").slice(0, 7),
			headline: commit.messageHeadline ?? "",
			author: commit.authors?.[0]?.login || commit.authors?.[0]?.name || "",
			at: commit.committedDate ?? "",
		})),
		mergeable: raw.mergeable ?? "UNKNOWN",
		labels: (raw.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
	};
}

/**
 * The CI answer, as a count and as the list behind it.
 *
 * The count is what a header needs: whether anything failed, in four words. The list is what you
 * need the moment the answer is "yes" — which check, and a way to go read it. Sending someone to
 * the web page to find out the name of the one red check is the sort of small errand that makes a
 * review tool something you leave.
 *
 * Three outcomes, not GitHub's dozen. `NEUTRAL` and `SKIPPED` count as passing because neither
 * blocks anything, and a reviewer scanning for red does not want them drawing the eye.
 */
export function summariseChecks(rollup: RawDetail["statusCheckRollup"]): PullRequestDetail["checks"] {
	if (!rollup || rollup.length === 0) return null;

	const items = rollup.map((check) => {
		const raw = (check.conclusion || check.state || check.status || "").toUpperCase();
		const state: PullRequestCheck["state"] =
			raw === "SUCCESS" || raw === "NEUTRAL" || raw === "SKIPPED"
				? "pass"
				: raw === "FAILURE" || raw === "ERROR" || raw === "TIMED_OUT" || raw === "CANCELLED"
					? "fail"
					: "pending";
		return { name: check.name?.trim() || "检查", state, url: check.detailsUrl };
	});

	return {
		total: items.length,
		passed: items.filter((c) => c.state === "pass").length,
		failed: items.filter((c) => c.state === "fail").length,
		pending: items.filter((c) => c.state === "pending").length,
		items,
	};
}

export async function pullRequestDiff(
	repo: string,
	number: number,
): Promise<{ files: WorkspaceDiffFile[]; error?: string }> {
	try {
		const { stdout } = await execFileAsync("gh", ["pr", "diff", String(number), "--repo", repo], {
			maxBuffer: 64 * 1024 * 1024,
		});
		return { files: parseUnifiedDiff(stdout) };
	} catch (error) {
		return { files: [], error: describe(error) };
	}
}

export async function commentOnPullRequest(repo: string, number: number, body: string): Promise<{ error?: string }> {
	if (!body.trim()) return { error: "评论不能为空" };
	try {
		await execFileAsync("gh", ["pr", "comment", String(number), "--repo", repo, "--body", body]);
		return {};
	} catch (error) {
		return { error: describe(error) };
	}
}

/** What a review can say. `approve` and `request-changes` are decisions; `comment` is not. */
export type ReviewVerdict = "approve" | "request-changes" | "comment";

export async function reviewPullRequest(
	repo: string,
	number: number,
	verdict: ReviewVerdict,
	body: string,
): Promise<{ error?: string }> {
	// GitHub refuses a change request with no explanation, and the error it returns for that is
	// opaque. Answering here costs a round trip nobody has to think about.
	if (verdict === "request-changes" && !body.trim()) return { error: "请求修改需要说明理由" };
	try {
		const args = ["pr", "review", String(number), "--repo", repo, `--${verdict}`];
		if (body.trim()) args.push("--body", body);
		await execFileAsync("gh", args);
		return {};
	} catch (error) {
		return { error: describe(error) };
	}
}

/**
 * What went wrong, in a sentence someone can act on.
 *
 * `gh` failures are mostly environmental — not installed, not logged in, no network — and the raw
 * stderr for each is several lines of noise around one fact.
 */
export function describe(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes("ENOENT")) return "未安装 gh CLI（brew install gh）";
	if (message.includes("not logged") || message.includes("authentication")) return "gh 未登录，请先运行 gh auth login";
	if (message.includes("Could not resolve to a Repository")) return "找不到这个仓库，或者没有访问权限";
	if (message.includes("ENOTFOUND") || message.includes("network")) return "连不上 GitHub";
	return message.split("\n")[0].slice(0, 200);
}
