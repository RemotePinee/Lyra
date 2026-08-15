/**
 * Reviewing a pull request.
 *
 * The agent gets the diff and read access to the checkout, which is what a reviewer has. It is
 * asked for the things a diff alone cannot show — whether the change is consistent with what is
 * around it, whether a rule the repository states is being broken, whether the tests that would
 * catch a regression exist.
 *
 * Deliberately not asked for: style opinions, praise, or a verdict. Lint already has the style
 * opinions, praise is noise on a page people scan for problems, and a bot that says "approved"
 * teaches people that approval means nothing.
 */

import { pullRequestDiff, upsertComment, type Repo } from "../github.ts";
import { runOnce } from "../agent.ts";

const REVIEW_MARKER = "<!-- deepwise-agent: review -->";

/** Past this the diff is truncated: a review of the first thousand lines is worth more than none. */
const MAX_DIFF_CHARS = 40_000;

/**
 * How many files it may open before answering.
 *
 * Without a number here a large diff turns into an hour of reading: the first run against a
 * fifty-file change opened thirty files and never got as far as writing anything down. A review
 * that names four real problems beats one that would have named six and timed out.
 */
const MAX_FILES_READ = 6;

export async function reviewPullRequest(args: {
	token: string;
	repo: Repo;
	number: number;
	cwd: string;
	verbose?: boolean;
}): Promise<void> {
	const diff = await pullRequestDiff(args.token, args.repo, args.number);
	const truncated = diff.length > MAX_DIFF_CHARS;
	const shown = truncated ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… 差异过长，已截断` : diff;

	const answer = await runOnce({
		cwd: args.cwd,
		verbose: args.verbose,
		prompt: prompt(args.number, shown, truncated),
	});

	const body = answer
		? `## 🤖 Agent 审查\n\n${answer}`
		: "## 🤖 Agent 审查\n\n没有跑出结果——大概是超时或者模型没有回复。看看 workflow 日志。";

	await upsertComment(args.token, args.repo, args.number, REVIEW_MARKER, body);
}

export function prompt(number: number, diff: string, truncated: boolean): string {
	return `你在审查这个仓库的 PR #${number}。仓库代码就在当前目录，你可以读、可以搜。

先读一遍 AGENTS.md，那里写着这个仓库的约定。然后看下面的 diff，必要时打开相关文件
看上下文——diff 显示的是改了什么，读文件才知道改得对不对。

**最多打开 ${MAX_FILES_READ} 个文件。** 挑最可能有问题的那几个，读完就下结论。读遍所有
改动文件却没时间写结论，比只读四个然后说清楚四件事要差得多。

要找的是这几类问题，按这个顺序：

1. **会出错的地方**：边界条件、空值、异步竞态、错误被吞掉、改了行为但没改对应的地方
2. **与仓库约定不符**：AGENTS.md 里写明的那些（缩进、注释讲为什么、不动 docs/、
   strip-types 不支持参数属性等）
3. **缺测试**：改了行为却没有测试能在它坏掉时失败
4. **可以更简单**：只在明显更简单时说，不要为了说而说

不要做的事：

- 不要评论代码风格——lint 已经管了，而且是 --deny-warnings
- 不要夸奖，不要总结改动做了什么（作者知道）
- 不要给结论性的批准或拒绝
- 没找到问题就直说"没找到问题"，那是一个有用的回答

格式：每条一段，开头用 \`文件路径:行号\` 定位，然后一句话说清楚问题是什么、
会怎么坏。最多 8 条，按严重程度排。${truncated ? "\n\n注意：diff 太长被截断了，请在结论里说明这一点。" : ""}

\`\`\`diff
${diff}
\`\`\``;
}
