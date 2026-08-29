/**
 * Git release preparation, dry-run monitoring, and publishing.
 *
 * Provides inspect info (latest tag, package versions, commits since last tag),
 * bump & commit versioning across Monorepo package.json files,
 * workflow trigger & monitoring for dry runs, and final release tagging.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { git } from "./git-exec.ts";
import { isGitRepo } from "./git.ts";

const pExecFile = promisify(execFile);

export interface ReleaseInfo {
	currentVersion: string;
	latestTag: string | null;
	commitsSinceTag: { sha: string; shortSha: string; subject: string; author: string; date: string }[];
	suggestedVersion: {
		patch: string;
		minor: string;
		major: string;
	};
}

export interface WorkflowJobStep {
	name: string;
	status: string;
	conclusion: string | null;
	number: number;
	startedAt?: string;
	completedAt?: string;
}

export interface WorkflowJob {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	url?: string;
	startedAt?: string;
	completedAt?: string;
	steps?: WorkflowJobStep[];
}

export interface WorkflowRunSummary {
	id: number;
	name: string;
	displayTitle: string;
	event: string;
	status: "queued" | "in_progress" | "completed" | "waiting" | "unknown";
	conclusion: "success" | "failure" | "cancelled" | "timed_out" | "skipped" | null;
	headBranch: string;
	headSha: string;
	createdAt: string;
	url: string;
	jobs?: WorkflowJob[];
}

export interface WorkflowRunStatus {
	id: number;
	name?: string;
	displayTitle?: string;
	event?: string;
	status: "queued" | "in_progress" | "completed" | "waiting" | "unknown";
	conclusion: "success" | "failure" | "cancelled" | "timed_out" | "skipped" | null;
	url: string;
	createdAt?: string;
	headBranch?: string;
	headSha?: string;
	jobs: WorkflowJob[];
}

/**
 * Increment semver version strings safely.
 */
export function bumpSemver(version: string, type: "patch" | "minor" | "major"): string {
	const clean = version.replace(/^v/, "").trim();
	const parts = clean.split(".").map((n) => Number.parseInt(n, 10) || 0);
	while (parts.length < 3) parts.push(0);

	if (type === "major") {
		return `${parts[0] + 1}.0.0`;
	}
	if (type === "minor") {
		return `${parts[0]}.${parts[1] + 1}.0`;
	}
	return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

/**
 * Find all package.json files across the workspace root and packages/*
 */
async function getPackageJsonPaths(cwd: string): Promise<string[]> {
	const results = [join(cwd, "package.json")];
	const packagesDir = join(cwd, "packages");
	try {
		const entries = await fs.readdir(packagesDir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory()) {
				const pkgPath = join(packagesDir, entry.name, "package.json");
				try {
					await fs.access(pkgPath);
					results.push(pkgPath);
				} catch {
					// Ignore subdirectories without package.json
				}
			}
		}
	} catch {
		// No packages folder
	}
	return results;
}

/**
 * Read current release readiness information from repository.
 */
export async function getReleaseInfo(cwd: string): Promise<ReleaseInfo> {
	if (!(await isGitRepo(cwd))) {
		throw new Error("当前目录不是 Git 仓库");
	}

	let currentVersion = "0.0.0";
	try {
		const rootPkg = JSON.parse(await fs.readFile(join(cwd, "package.json"), "utf8"));
		if (rootPkg.version) currentVersion = rootPkg.version;
	} catch {
		// fallback to 0.0.0
	}

	// Find the latest tag
	const latestTag = await git(cwd, ["describe", "--tags", "--abbrev=0"])
		.then((out) => out.trim())
		.catch(() => null);

	// Get commits since tag or all commits if no tag
	const range = latestTag ? [`${latestTag}..HEAD`] : ["-n", "50"];
	const logOut = await git(cwd, ["log", "--no-merges", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ad", ...range])
		.then((out) => out.trim())
		.catch(() => "");

	const commitsSinceTag = logOut
		? logOut
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [sha, shortSha, subject, author, date] = line.split("\x1f");
					return { sha, shortSha, subject, author, date };
				})
		: [];

	return {
		currentVersion,
		latestTag,
		commitsSinceTag,
		suggestedVersion: {
			patch: bumpSemver(currentVersion, "patch"),
			minor: bumpSemver(currentVersion, "minor"),
			major: bumpSemver(currentVersion, "major"),
		},
	};
}

/**
 * Bump version across all package.json files in repository.
 */
export async function bumpVersionFiles(cwd: string, newVersion: string): Promise<{ ok: boolean; error?: string }> {
	const version = newVersion.replace(/^v/, "").trim();
	if (!/^\d+\.\d+\.\d+/.test(version)) {
		return { ok: false, error: "版本号格式不正确 (必须符合 x.y.z)" };
	}

	try {
		const pkgPaths = await getPackageJsonPaths(cwd);
		for (const pkgPath of pkgPaths) {
			const content = await fs.readFile(pkgPath, "utf8");
			const json = JSON.parse(content);
			json.version = version;
			await fs.writeFile(pkgPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
		}
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Execute a github cli command with PATH fallback
 */
async function execGh(cwd: string, args: string[]): Promise<string> {
	const env = {
		...process.env,
		PATH: `${process.env.PATH || ""}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
	};
	const { stdout } = await pExecFile("gh", args, { cwd, env });
	return stdout;
}

/**
 * Trigger GitHub Actions Release Dry Run workflow
 */
export async function triggerReleaseDryRun(cwd: string): Promise<{ ok: boolean; runId?: number; error?: string }> {
	try {
		// Trigger workflow_dispatch for release-dryrun.yml
		await execGh(cwd, ["workflow", "run", "release-dryrun.yml"]);

		// Wait briefly and poll for the newly started run
		for (let i = 0; i < 4; i++) {
			await new Promise((resolve) => setTimeout(resolve, 1500));
			const listJson = await execGh(cwd, [
				"run",
				"list",
				"--workflow=release-dryrun.yml",
				"--limit=1",
				"--json=databaseId,status,url",
			]);

			try {
				const runs = JSON.parse(listJson);
				if (Array.isArray(runs) && runs[0]?.databaseId) {
					return { ok: true, runId: runs[0].databaseId };
				}
			} catch {
				// parse failed, continue retry
			}
		}
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error:
				err instanceof Error
					? err.message
					: "触发 GitHub Actions 失败，请检查是否安装配置了 gh CLI 并且具有仓库权限",
		};
	}
}

/**
 * List recent GitHub Actions workflow runs for the repository.
 */
export async function listWorkflowRuns(cwd: string, limit = 20): Promise<WorkflowRunSummary[]> {
	try {
		const out = await execGh(cwd, [
			"run",
			"list",
			`--limit=${limit}`,
			"--json=databaseId,name,displayTitle,event,status,conclusion,headBranch,headSha,createdAt,url",
		]);
		const runs = JSON.parse(out);
		if (!Array.isArray(runs)) return [];
		return runs.map((r: {
			databaseId: number;
			name: string;
			displayTitle: string;
			event: string;
			status: WorkflowRunSummary["status"];
			conclusion: WorkflowRunSummary["conclusion"];
			headBranch: string;
			headSha: string;
			createdAt: string;
			url: string;
		}) => ({
			id: r.databaseId,
			name: r.name,
			displayTitle: r.displayTitle,
			event: r.event,
			status: r.status,
			conclusion: r.conclusion,
			headBranch: r.headBranch,
			headSha: r.headSha,
			createdAt: r.createdAt,
			url: r.url,
		}));
	} catch {
		return [];
	}
}

/**
 * Get GitHub Actions Run status with detailed jobs and steps
 */
export async function getWorkflowRunStatus(cwd: string, runId: number): Promise<WorkflowRunStatus | null> {
	try {
		const out = await execGh(cwd, [
			"run",
			"view",
			String(runId),
			"--json=databaseId,name,displayTitle,event,status,conclusion,url,jobs,createdAt,headBranch,headSha",
		]);
		const data = JSON.parse(out);
		return {
			id: data.databaseId,
			name: data.name,
			displayTitle: data.displayTitle,
			event: data.event,
			status: data.status,
			conclusion: data.conclusion,
			url: data.url,
			createdAt: data.createdAt,
			headBranch: data.headBranch,
			headSha: data.headSha,
			jobs: Array.isArray(data.jobs)
				? data.jobs.map((j: {
						databaseId?: number;
						id?: number;
						name: string;
						status: string;
						conclusion: string | null;
						url?: string;
						startedAt?: string;
						completedAt?: string;
						steps?: WorkflowJobStep[];
					}) => ({
						id: j.databaseId ?? j.id ?? 0,
						name: j.name,
						status: j.status,
						conclusion: j.conclusion,
						url: j.url,
						startedAt: j.startedAt,
						completedAt: j.completedAt,
						steps: Array.isArray(j.steps)
							? j.steps.map((s) => ({
									name: s.name,
									status: s.status,
									conclusion: s.conclusion,
									number: s.number,
									startedAt: s.startedAt,
									completedAt: s.completedAt,
								}))
							: [],
					}))
				: [],
		};
	} catch {
		return null;
	}
}

/**
 * Create a release Git tag and push it to trigger the final release workflow.
 */
export async function publishReleaseTag(
	cwd: string,
	version: string,
): Promise<{ ok: boolean; tag?: string; error?: string }> {
	const tag = version.startsWith("v") ? version.trim() : `v${version.trim()}`;
	try {
		// Stage and commit version bumps if not yet committed
		const statusOut = await git(cwd, ["status", "--porcelain"]).catch(() => "");
		if (statusOut.includes("package.json")) {
			await git(cwd, ["add", "package.json", "packages/*/package.json"]);
			await git(cwd, ["commit", "-m", `chore(release): bump version to ${version.replace(/^v/, "")}`]);
			await git(cwd, ["push"]);
		}

		// Create and push tag
		await git(cwd, ["tag", tag]);
		await git(cwd, ["push", "origin", tag]);
		return { ok: true, tag };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
