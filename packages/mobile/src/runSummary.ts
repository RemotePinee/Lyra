/**
 * What the agent is doing, translated into words and mood for the mobile interface.
 * Ported losslessly from desktop `thinking-words.ts` and `RunningIndicator.tsx`.
 */

export type Mood =
	| "listening"
	| "composing"
	| "shaping"
	| "working"
	| "searching"
	| "solving"
	| "connecting"
	| "weaving"
	| "breathing";

const WORDS: Record<Mood, string[]> = {
	listening: ["Reading up", "Skimming", "Digging in", "Getting the lay of it", "Poking around the source"],
	composing: ["Writing", "Drafting", "Putting it down", "Getting it on paper", "Laying down code"],
	shaping: ["Reworking", "Editing", "Reshaping it", "Moving things around", "Knocking it into shape"],
	working: ["Running it", "Kicking it off", "Letting it rip", "Waiting on the shell", "Turning the crank"],
	searching: ["Hunting", "Rummaging", "Casting about", "Following the thread", "Combing through"],
	solving: ["Proving it", "Running the gauntlet", "Making sure", "Putting it through its paces"],
	connecting: ["Having a look", "Loading the page", "Peeking at the web", "Reaching out"],
	weaving: ["Plotting", "Lining it up", "Sketching the order", "Working out the steps"],
	breathing: ["Thinking", "Mulling", "Turning it over", "Chewing on it", "Working it out", "Pondering"],
};

const PATIENCE_MS = 45_000;
const LONG_WORDS = ["Still at it", "This one's stubborn", "Taking its time", "Nearly there", "Wrestling with it"];

const BY_TOOL: Record<string, Mood> = {
	read: "listening",
	symbol: "listening",
	write: "composing",
	preview: "composing",
	edit: "shaping",
	bash: "working",
	bash_output: "working",
	glob: "searching",
	grep: "searching",
	ls: "searching",
	todo_write: "weaving",
	task: "weaving",
	web_fetch: "connecting",
	web_search: "connecting",
	browser_act: "connecting",
};

const TEST_HINT = /\b(test|jest|vitest|pytest|spec|coverage)\b/i;

export function moodFor(
	toolName: string | undefined,
	summary: string | undefined,
	retrying = false,
	writing = false,
): Mood {
	if (retrying) return "connecting";
	if (summary && TEST_HINT.test(summary)) return "solving";
	if (toolName) return BY_TOOL[toolName] ?? "breathing";
	return writing ? "composing" : "breathing";
}

export function phraseFor(mood: Mood, tick: number, elapsedMs = 0): string {
	if (elapsedMs > PATIENCE_MS) return LONG_WORDS[tick % LONG_WORDS.length];
	const pool = WORDS[mood] ?? WORDS.breathing;
	return pool[tick % pool.length];
}

/**
 * Maps a list of tool calls into grouped action summaries (like Desktop describeRun).
 */
export function describeRun(calls: { toolName: string; summary?: string }[]): string {
	const counts = new Map<string, number>();
	const buckets = new Map<string, string[]>();

	for (const call of calls) {
		const kind = KIND[call.toolName] ?? "使用工具";
		counts.set(kind, (counts.get(kind) ?? 0) + 1);

		if (call.summary) {
			const list = buckets.get(kind) ?? [];
			// Extract target name if clean
			const target = cleanSubject(call.toolName, call.summary);
			if (target) list.push(target);
			buckets.set(kind, list);
		}
	}

	const parts: string[] = [];
	for (const [kind, count] of counts) {
		const subjects = buckets.get(kind) ?? [];
		if (count === 1 && subjects.length === 1) {
			parts.push(`${kind} ${subjects[0]}`);
		} else if (count === 1) {
			parts.push(kind);
		} else {
			parts.push(`${kind} ${count} 个`);
		}
	}

	return parts.join("、");
}

function cleanSubject(toolName: string, summary: string): string | undefined {
	if (toolName === "read" || toolName === "write" || toolName === "edit") {
		const match = /(?:Read|Write|Edit)\s+(.*)/i.exec(summary);
		if (match) {
			const p = match[1].trim();
			return p.split(/[/\\]/).pop() ?? p;
		}
	}
	if (toolName === "grep" || toolName === "glob") {
		const match = /(?:Search|Find)\s+(.*)/i.exec(summary);
		if (match) return match[1].trim();
	}
	return undefined;
}

const KIND: Record<string, string> = {
	write: "创建文件",
	edit: "修改文件",
	read: "读取文件",
	bash: "执行命令",
	bash_output: "查看输出",
	glob: "查找文件",
	grep: "搜索内容",
	ls: "列出目录",
	todo_write: "更新清单",
	web_fetch: "抓取网页",
	web_search: "搜索网络",
	task: "派发子任务",
	preview: "生成预览",
	symbol: "查找符号",
};

export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes >= 60) {
		const hours = Math.floor(minutes / 60);
		return `${hours}h ${minutes % 60}m`;
	}
	return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

export function formatTokens(count: number): string {
	if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`;
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return String(count);
}
