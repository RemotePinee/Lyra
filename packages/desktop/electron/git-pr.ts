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
import type { PullRequestCheck, PullRequestDetail, PullRequestSummary, WorkspaceDiffFile } from "./ipc-shapes.ts";
import { BUCKETS, dedupe, parseSearch, PER_BUCKET, SEARCH_QUERY, toSummary } from "./pr-summary.ts";

const execFileAsync = promisify(execFile);

/**
 * A ceiling on any one `gh` call.
 *
 * Without it a connection that opens and then says nothing leaves the process alive forever, and
 * with the list now refreshing on a timer that is not a hang that ends when someone gives up and
 * closes the screen — it is a `gh` process per minute, each holding a socket, none of them ever
 * answering the promise the renderer is waiting on.
 */
const CALL_TIMEOUT_MS = 30_000;

type ListResult = { pullRequests: PullRequestSummary[]; error?: string };

/**
 * The one search in flight, handed to everyone who asks while it is running.
 *
 * The list refreshes itself now — on a timer, when the window comes back, and whenever somebody
 * presses the arrow — so "two requests for the same answer at the same time" stopped being a
 * theoretical case. Each one is a `gh` process and a round trip, and the second one cannot return
 * anything the first will not.
 */
let inFlight: ListResult | Promise<ListResult> | null = null;

export function listMyPullRequests(): Promise<ListResult> {
	if (!inFlight) {
		inFlight = searchAll().finally(() => {
			inFlight = null;
		});
	}
	return Promise.resolve(inFlight);
}

async function searchAll(): Promise<ListResult> {
	try {
		const { stdout } = await execFileAsync(
			"gh",
			[
				"api", "graphql",
				"-f", `query=${SEARCH_QUERY}`,
				...BUCKETS.flatMap(({ relation, query }) => ["-f", `${relation}=${query}`]),
				"-F", `n=${PER_BUCKET}`,
			],
			{ maxBuffer: 8 * 1024 * 1024, timeout: CALL_TIMEOUT_MS },
		);
		const found = parseSearch(stdout);
		return { pullRequests: dedupe(BUCKETS.map(({ relation }) => found[relation].map((pr) => toSummary(pr, relation)))) };
	} catch (error) {
		return { pullRequests: [], error: describe(error) };
	}
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
	"reviewDecision",
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
			timeout: CALL_TIMEOUT_MS,
		});
		return { detail: toDetail(repo, JSON.parse(stdout) as RawDetail) };
	} catch (error) {
		return { error: describe(error) };
	}
}

interface RawDetail {
	number: number;
	title: string;
	url: string;
	state?: string;
	isDraft?: boolean;
	createdAt: string;
	updatedAt: string;
	author?: { login?: string } | null;
	body?: string;
	additions?: number;
	deletions?: number;
	changedFiles?: number;
	headRefName?: string;
	baseRefName?: string;
	reviewDecision?: string | null;
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
	const checks = summariseChecks(raw.statusCheckRollup);

	return {
		repo,
		number: raw.number,
		title: raw.title,
		author: raw.author?.login ?? "unknown",
		/*
		 * `gh pr view` does not carry one, and the row that opened this one does — so the picture is
		 * already in the renderer's cache by the time this arrives, and asking for it again over a
		 * second API would be a request for something nobody would see appear.
		 */
		avatarUrl: null,
		state: (raw.state ?? "open").toUpperCase(),
		isDraft: raw.isDraft === true,
		url: raw.url,
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt,
		/** Meaningless for a single pull request; the list is where a relation decides anything. */
		relation: "authored",
		reviewDecision: raw.reviewDecision || null,
		// The same three outcomes the list draws, from the same numbers the section below reports.
		checkState: checks ? (checks.failed > 0 ? "fail" : checks.pending > 0 ? "pending" : "pass") : null,
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
		checks,
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
