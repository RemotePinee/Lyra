/**
 * Portable mood and phrase mapping for mobile running state.
 * Aligned with desktop thinking-words logic.
 */

export type Mood =
	| "breathing"
	| "listening"
	| "searching"
	| "working"
	| "solving"
	| "connecting"
	| "weaving"
	| "composing"
	| "shaping";

const WORDS: Record<Mood, string[]> = {
	listening: ["Reading up", "Skimming", "Digging in", "Getting the lay of it", "Poking around"],
	composing: ["Writing", "Drafting", "Putting it down", "Laying down code"],
	shaping: ["Reworking", "Editing", "Reshaping it", "Moving things around"],
	working: ["Running it", "Executing command", "Waiting on shell", "Turning the crank"],
	searching: ["Hunting", "Rummaging", "Combing through", "Finding files"],
	solving: ["Proving it", "Running tests", "Making sure", "Checking results"],
	connecting: ["Having a look", "Loading page", "Peeking web", "Reaching out"],
	weaving: ["Plotting", "Lining it up", "Sketching steps", "Working out plan"],
	breathing: ["Thinking", "Mulling", "Turning it over", "Working it out", "Pondering"],
};

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
	web_search: "connecting",
	web_fetch: "connecting",
	todo_write: "weaving",
	task: "weaving",
};

export function moodFor(
	toolName?: string,
	summary?: string,
	writing?: boolean
): Mood {
	if (writing) return "composing";
	if (!toolName) return "breathing";

	if (toolName === "bash" && summary && /(?:npm|pnpm|yarn|bun|cargo|go|pytest|vitest|jest)\s+test\b/i.test(summary)) {
		return "solving";
	}

	return BY_TOOL[toolName] ?? "working";
}

export function phraseFor(mood: Mood, tick: number): string {
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

/**
 * A token count at a glance: 812, 12.3k, 4.1M, 2.7B.
 * Direct copy from Desktop RunningIndicator.tsx formatTokens.
 */
export function formatTokens(count: number): string {
	if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`;
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return String(count);
}
