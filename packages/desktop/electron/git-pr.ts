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
	{ relation: "reviewing", query: "is:pr is:open review-requested:@me" },
	{ relation: "authored", query: "is:pr is:open author:@me" },
	{ relation: "reviewed", query: "is:pr is:open reviewed-by:@me" },
] as const;

type Relation = (typeof BUCKETS)[number]["relation"];

export async function listMyPullRequests(): Promise<{ pullRequests: PullRequestSummary[]; error?: string }> {
	let buckets: PullRequestSummary[][];
	try {
		const found = await searchAll();
		buckets = BUCKETS.map(({ relation }) => found[relation].map((pr) => toSummary(pr, relation)));
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

/**
 * All three buckets in one GraphQL query, which is the whole reason this is not `gh search prs`.
 *
 * `gh search prs` goes to the REST search endpoint, and GitHub rate-limits that one far harder
 * than the rest of the API: **30 requests per minute**, separate from and much smaller than the
 * ordinary hourly budget. Three buckets meant three of those thirty spent on every refresh, so a
 * few visits to this screen in quick succession — open it, refresh, come back — ran the list into
 * "API rate limit exceeded" while nothing else on the machine was anywhere near a limit.
 *
 * GraphQL charges against the hourly budget instead (5,000 points an hour, and a query like this
 * one costs single digits), and aliases let all three searches travel in a single request. Same
 * three questions, one round trip, a budget that is not realistically reachable by a person
 * clicking refresh.
 */
const SEARCH_QUERY = `
query($reviewing: String!, $authored: String!, $reviewed: String!, $n: Int!) {
  reviewing: search(query: $reviewing, type: ISSUE, first: $n) { nodes { ...row } }
  authored:  search(query: $authored,  type: ISSUE, first: $n) { nodes { ...row } }
  reviewed:  search(query: $reviewed,  type: ISSUE, first: $n) { nodes { ...row } }
}
fragment row on PullRequest {
  number
  title
  url
  state
  isDraft
  createdAt
  updatedAt
  author { login }
  repository { nameWithOwner }
  comments { totalCount }
}`;

async function searchAll(): Promise<Record<Relation, RawSearchItem[]>> {
	const { stdout } = await execFileAsync(
		"gh",
		[
			"api", "graphql",
			"-f", `query=${SEARCH_QUERY}`,
			...BUCKETS.flatMap(({ relation, query }) => ["-f", `${relation}=${query}`]),
			"-F", `n=${PER_BUCKET}`,
		],
		{ maxBuffer: 8 * 1024 * 1024 },
	);

	const body = JSON.parse(stdout) as {
		data?: Record<string, { nodes?: (SearchNode | null)[] } | null>;
		errors?: { message?: string }[];
	};
	/*
	 * A GraphQL error arrives with a 200 and an `errors` array, so it has to be looked for rather
	 * than caught. Rate limiting is exactly this shape, which is the failure this function exists
	 * to avoid — reporting it as an empty list would be the worst of both.
	 */
	if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).filter(Boolean).join("; "));

	const out = {} as Record<Relation, RawSearchItem[]>;
	for (const { relation } of BUCKETS) {
		out[relation] = (body.data?.[relation]?.nodes ?? [])
			// `type: ISSUE` also matches issues, which come back as empty nodes and are dropped.
			.filter((node): node is SearchNode => Boolean(node && typeof node.number === "number"))
			// The comment count is the one field GraphQL shapes differently to the rest of this
			// file, so it is flattened here rather than followed inwards.
			.map(({ comments, ...node }) => ({ ...node, commentsCount: comments?.totalCount ?? 0 }));
	}
	return out;
}

/** One row as GraphQL returns it, before the comment count is flattened. */
interface SearchNode extends Omit<RawSearchItem, "commentsCount"> {
	comments?: { totalCount?: number } | null;
}

interface RawSearchItem {
	number: number;
	title: string;
	author?: { login?: string } | null;
	repository?: { nameWithOwner?: string } | null;
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
	// Says what to do about it. The unedited message is a paragraph about REST quotas that does not
	// mention how long the wait is, and this list refreshes on its own anyway.
	if (message.includes("rate limit") || message.includes("secondary rate")) {
		return "GitHub 暂时限流了，过一会儿会自动恢复";
	}
	return message.split("\n")[0].slice(0, 200);
}
