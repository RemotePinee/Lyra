import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Spinner } from "./RunningIndicator.tsx";

/**
 * A stretch of tool work, said in one line.
 *
 * Every run of calls looks the same here whether it is one file or nine — and that sameness is
 * the point. The transcript used to switch between two languages: a short run drew a row of
 * bordered cards, a long one collapsed to a line of grey text, and the eye had to re-learn what
 * it was looking at every few paragraphs. One form, always, reads as prose with the reply rather
 * than as furniture between paragraphs.
 *
 * The line says what was done, not how many things were done. "执行了 4 个操作" is a count of
 * events nobody witnessed; "创建 2 个文件、执行 2 条命令" is the same row of cards, read.
 */
export function ToolGroup({
	summary,
	added,
	removed,
	running,
	children,
}: {
	/** What this run did, in words — see `describeRun`. */
	summary: string;
	/** Lines added and removed across the whole run, when any of it touched a file. */
	added?: number;
	removed?: number;
	running?: boolean;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const body = useRef<HTMLDivElement>(null);
	const [height, setHeight] = useState(0);

	// Measured rather than guessed, for the same reason as the task list: an animation to a
	// max-height that is not the real one either clips the list or finishes early.
	useEffect(() => {
		const element = body.current;
		if (!element) return;
		const measure = () => setHeight(element.scrollHeight);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [children, open]);

	/*
	 * Close above, open below.
	 *
	 * A summary line belongs to the sentence that introduced it — "现在写后端核心文件：" and
	 * "创建文件 3 个" are one thought — so the gap above it is small and the gap below it is what
	 * separates this stretch of work from the next. They used to be the same size, which left
	 * every line floating between two paragraphs, belonging to neither.
	 */
	return (
		<div className="mb-3.5">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				className="dw-scroll group/run flex w-full items-center gap-1.5 rounded-md py-0.5 text-left text-[12.5px] text-ink-faint transition-colors hover:text-ink-muted"
			>
				{running && <Spinner size={11} className="shrink-0" />}
				{/*
				 * Keyed on the text so a change is a new element: the old one is gone and the new
				 * one fades in, which reads as a change rather than as a flicker.
				 */}
				<span key={summary} className="dw-fade-in min-w-0 truncate">
					{summary}
				</span>
				{(added ?? 0) + (removed ?? 0) > 0 && (
					<span className="shrink-0 font-mono text-[11px]">
						<span className="text-ok/80">+{added ?? 0}</span> <span className="text-danger/80">-{removed ?? 0}</span>
					</span>
				)}
				<ChevronRight
					size={12}
					strokeWidth={2}
					className="shrink-0 opacity-0 transition-all duration-200 group-hover/run:opacity-100"
					style={open ? { transform: "rotate(90deg)", opacity: 1 } : undefined}
				/>
			</button>

			<div style={{ height: open ? height : 0 }} className="overflow-hidden transition-[height] duration-200 ease-out">
				<div ref={body} className="pt-1">
					{children}
				</div>
			</div>
		</div>
	);
}

/**
 * What a run of calls did, in the words someone would use to describe it afterwards.
 *
 * Grouped by the kind of action rather than by tool name, because "读取" is what three different
 * tools amount to from the outside. One action of one kind names its subject — that is the case
 * where the detail fits and is worth having; anything more is counted.
 */
export function describeRun(calls: { toolName: string; subject?: string }[]): string {
	const buckets = new Map<string, string[]>();
	for (const call of calls) {
		const kind = KIND[call.toolName] ?? "使用工具";
		const list = buckets.get(kind) ?? [];
		if (call.subject) list.push(call.subject);
		buckets.set(kind, list);
	}

	const counts = new Map<string, number>();
	for (const call of calls) counts.set(KIND[call.toolName] ?? "使用工具", (counts.get(KIND[call.toolName] ?? "使用工具") ?? 0) + 1);

	const parts: string[] = [];
	for (const [kind, count] of counts) {
		const subjects = buckets.get(kind) ?? [];
		// One of a kind, with a name worth saying: say it.
		if (count === 1 && subjects.length === 1) parts.push(`${kind} ${subjects[0]}`);
		// One of a kind with nothing to name — "执行命令 1 个" counts to one, which is just noise.
		else if (count === 1) parts.push(kind);
		else parts.push(`${kind} ${count} 个`);
	}
	return parts.join("、");
}

/** Tool names to the plain verb for what they do. */
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
