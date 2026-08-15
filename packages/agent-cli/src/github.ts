/**
 * Talking to GitHub from inside a workflow.
 *
 * Plain `fetch` against the REST API rather than a client library or the `gh` binary: what this
 * needs is four calls, and the token is already in the environment. A dependency here would be
 * one more thing to keep up to date for no capability we would use.
 *
 * Every call goes through `api`, so the token, the version header and the failure mode are stated
 * once. A failed write throws with the body included — a workflow that silently failed to comment
 * is worse than one that goes red.
 */

const API = "https://api.github.com";

export interface Repo {
	owner: string;
	name: string;
}

/** The environment a workflow always provides, read once so a missing one fails immediately. */
export function contextFromEnv(): { repo: Repo; token: string } {
	const slug = required("GITHUB_REPOSITORY");
	const [owner, name] = slug.split("/");
	if (!owner || !name) throw new Error(`GITHUB_REPOSITORY is not owner/name: ${slug}`);
	return { repo: { owner, name }, token: required("GITHUB_TOKEN") };
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`missing ${name}`);
	return value;
}

async function api(token: string, path: string, init: RequestInit = {}): Promise<unknown> {
	const response = await fetch(`${API}${path}`, {
		...init,
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${token}`,
			"x-github-api-version": "2022-11-28",
			"content-type": "application/json",
			...init.headers,
		},
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`GitHub ${init.method ?? "GET"} ${path} → ${response.status}: ${body.slice(0, 400)}`);
	}
	return response.status === 204 ? null : response.json();
}

/** A pull request's diff, in the format the model reads best: the patch itself. */
export async function pullRequestDiff(token: string, repo: Repo, number: number): Promise<string> {
	const response = await fetch(`${API}/repos/${repo.owner}/${repo.name}/pulls/${number}`, {
		headers: {
			accept: "application/vnd.github.v3.diff",
			authorization: `Bearer ${token}`,
			"x-github-api-version": "2022-11-28",
		},
	});
	if (!response.ok) throw new Error(`diff for #${number} → ${response.status}`);
	return response.text();
}

export interface IssueLike {
	title: string;
	body: string;
	labels: string[];
}

export async function readIssue(token: string, repo: Repo, number: number): Promise<IssueLike> {
	const raw = (await api(token, `/repos/${repo.owner}/${repo.name}/issues/${number}`)) as {
		title?: string;
		body?: string;
		labels?: ({ name?: string } | string)[];
	};
	return {
		title: raw.title ?? "",
		body: raw.body ?? "",
		labels: (raw.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
	};
}

/**
 * Leave a comment, replacing this agent's previous one if there is one.
 *
 * Editing rather than appending, because a pull request that gets five pushes should not end up
 * with five reviews of five different versions of itself. The marker is how the old one is found.
 */
export async function upsertComment(
	token: string,
	repo: Repo,
	number: number,
	marker: string,
	body: string,
): Promise<void> {
	const existing = (await api(token, `/repos/${repo.owner}/${repo.name}/issues/${number}/comments?per_page=100`)) as {
		id: number;
		body?: string;
	}[];
	const mine = existing.find((c) => (c.body ?? "").includes(marker));
	const payload = JSON.stringify({ body: `${body}\n\n${marker}` });

	if (mine) {
		await api(token, `/repos/${repo.owner}/${repo.name}/issues/comments/${mine.id}`, {
			method: "PATCH",
			body: payload,
		});
		return;
	}
	await api(token, `/repos/${repo.owner}/${repo.name}/issues/${number}/comments`, { method: "POST", body: payload });
}

/** Add labels without removing what a person already put there. */
export async function addLabels(token: string, repo: Repo, number: number, labels: string[]): Promise<void> {
	if (labels.length === 0) return;
	await api(token, `/repos/${repo.owner}/${repo.name}/issues/${number}/labels`, {
		method: "POST",
		body: JSON.stringify({ labels }),
	});
}

export async function removeLabel(token: string, repo: Repo, number: number, label: string): Promise<void> {
	try {
		await api(token, `/repos/${repo.owner}/${repo.name}/issues/${number}/labels/${encodeURIComponent(label)}`, {
			method: "DELETE",
		});
	} catch {
		// Already gone, which is the state we wanted anyway.
	}
}
