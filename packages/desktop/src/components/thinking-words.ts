/**
 * What to call the waiting.
 *
 * A turn is mostly silence — a spinner and a number counting up. The number says how long, the
 * spinner says it is alive, and neither says what kind of waiting this is. Reading a file, running
 * a test and hunting through a codebase feel different to sit through, and naming the difference
 * is most of what makes a long turn bearable.
 *
 * Written here, not asked of the model. Making it produce a status line would cost a request per
 * phrase, arrive too late to describe what it is doing now, and put one more thing in the way of
 * the actual answer. These are picked from what the agent has just done, which the window already
 * knows.
 *
 * The tone is deliberately colloquial. This is the app talking about itself in the corner of the
 * screen, not a progress dialog reporting to a manager.
 */

/** The kinds of waiting worth distinguishing, in the order they get checked. */
export type Mood = "reading" | "writing" | "running" | "searching" | "testing" | "browsing" | "planning" | "thinking";

const WORDS: Record<Mood, string[]> = {
	reading: ["翻资料", "读一读", "看看这写了啥", "先把上下文吃透", "扒源码"],
	writing: ["落笔", "码字中", "写起来了", "敲代码", "把想法写下来"],
	running: ["跑一下", "让它跑跑看", "执行中", "等命令回话", "开火"],
	searching: ["翻箱倒柜", "满仓库找", "顺藤摸瓜", "找线索", "大海捞针"],
	testing: ["验一验", "跑测试", "看看能不能过", "拿证据说话", "压一压"],
	browsing: ["看看网页", "上网查查", "翻页面", "对着浏览器瞧"],
	planning: ["排排计划", "捋顺序", "列个单子", "分分步骤"],
	thinking: ["正在琢磨", "捋一捋思路", "转脑子", "盘一盘", "想办法", "琢磨路子"],
};

/** After this long on one step, the wording acknowledges that it is taking a while. */
const PATIENCE_MS = 45_000;
const LONG_WORDS = ["还在忙", "这个有点费劲", "慢工出细活", "再等等，快了", "有点难啃"];

const BY_TOOL: Record<string, Mood> = {
	read: "reading",
	symbol: "reading",
	write: "writing",
	edit: "writing",
	bash: "running",
	bash_output: "running",
	glob: "searching",
	grep: "searching",
	ls: "searching",
	todo_write: "planning",
	task: "planning",
	web_fetch: "browsing",
	web_search: "browsing",
	browser_act: "browsing",
	preview: "writing",
};

/** Commands that are really a test run, whatever tool they arrived through. */
const TEST_HINT = /\b(test|jest|vitest|pytest|spec|coverage)\b/i;

export function moodFor(toolName: string | undefined, summary: string | undefined): Mood {
	if (summary && TEST_HINT.test(summary)) return "testing";
	if (!toolName) return "thinking";
	return BY_TOOL[toolName] ?? "thinking";
}

/**
 * One phrase, chosen without a random number generator.
 *
 * Seeded by the mood and a slowly advancing tick so the same mood does not repeat the same word
 * back to back, and so a re-render never swaps the phrase on its own — only time does. Random
 * would change it on every paint, which is the flicker this is meant to avoid.
 */
export function phraseFor(mood: Mood, tick: number, elapsedMs: number): string {
	if (elapsedMs > PATIENCE_MS) return LONG_WORDS[tick % LONG_WORDS.length];
	const pool = WORDS[mood];
	return pool[tick % pool.length];
}
