#!/usr/bin/env -S node --experimental-strip-types
/**
 * The agent that works on this repository, as a command.
 *
 * Run from a workflow, but a plain command on purpose: the same invocation works on a laptop with
 * the same three environment variables, which is the difference between a thing you can debug and
 * a thing that only ever fails in CI.
 *
 *   DEEPWISE_BASE_URL=… DEEPWISE_API_KEY=… GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo \
 *     node --experimental-strip-types packages/agent-cli/src/main.ts review 42
 */

import { contextFromEnv } from "./github.ts";
import { reviewPullRequest } from "./tasks/review.ts";
import { triageIssue } from "./tasks/triage.ts";

const USAGE = `用法:
  deepwise-agent review <pr-number>    审查一个 PR，把结果写成评论
  deepwise-agent triage <issue-number> 给一个 issue 分类并指出缺什么

环境变量:
  DEEPWISE_BASE_URL   模型端点
  DEEPWISE_API_KEY    模型密钥
  DEEPWISE_MODEL      模型名，默认 deepseek-v4-flash
  GITHUB_TOKEN        写评论和标签用
  GITHUB_REPOSITORY   owner/name`;

async function main(): Promise<void> {
	const [command, argument] = process.argv.slice(2);
	if (!command || command === "--help" || command === "-h") {
		console.log(USAGE);
		return;
	}

	const number = Number(argument);
	if (!Number.isInteger(number) || number <= 0) {
		throw new Error(`需要一个编号，收到 "${argument ?? ""}"\n\n${USAGE}`);
	}

	const { repo, token } = contextFromEnv();
	const cwd = process.env.GITHUB_WORKSPACE ?? process.cwd();
	const verbose = process.env.RUNNER_DEBUG === "1" || process.env.DEEPWISE_VERBOSE === "1";

	if (command === "review") {
		await reviewPullRequest({ token, repo, number, cwd, verbose });
		return;
	}
	if (command === "triage") {
		await triageIssue({ token, repo, number, cwd, verbose });
		return;
	}
	throw new Error(`未知命令 "${command}"\n\n${USAGE}`);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
