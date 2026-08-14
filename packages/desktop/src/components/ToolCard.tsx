import type { DiffHunk, ToolResult } from "@deepwise/core";
import { Scroller } from "./Scroller.tsx";
import {
	ChevronRight,
	CircleCheck,
	CircleX,
	FileCode,
	FilePlus,
	FileText,
	FolderTree,
	Globe,
	ListTodo,
	Loader2,
	Search,
	Sparkles,
	Terminal,
	Users,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DiffView } from "./DiffView.tsx";

const ICONS: Record<string, typeof FileText> = {
	read: FileText,
	write: FilePlus,
	edit: FileCode,
	ls: FolderTree,
	glob: Search,
	grep: Search,
	bash: Terminal,
	bash_output: Terminal,
	todo_write: ListTodo,
	task: Users,
	skill: Sparkles,
	web_fetch: Globe,
};

interface ToolCardProps {
	toolName: string;
	summary: string;
	args: Record<string, unknown>;
	status: "running" | "done" | "error";
	result?: ToolResult;
}

export function ToolCard({ toolName, summary, args, status, result }: ToolCardProps) {
	const [open, setOpen] = useState(false);
	const [elapsed, setElapsed] = useState(0);
	const Icon = ICONS[toolName] ?? (toolName.startsWith("mcp__") ? Globe : Terminal);
	const details = result?.details as Record<string, unknown> | undefined;
	const hasDiff = Array.isArray(details?.hunks) && (details.hunks as DiffHunk[]).length > 0;
	const running = status === "running";

	// A visible timer is the honest signal that a long command is still going.
	const startedAt = useRef(Date.now());
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 250);
		return () => clearInterval(timer);
	}, [running]);

	return (
		<div
			className={`dw-enter mb-2 overflow-hidden rounded-[10px] border transition-colors duration-200 ${
				running ? "dw-rail border-info/30 bg-card/60" : "border-line-soft bg-card/45"
			}`}
		>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="dw-scroll flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-150 hover:bg-card-hover/50"
			>
				<Icon
					size={14}
					strokeWidth={1.8}
					className={`shrink-0 transition-colors duration-200 ${running ? "dw-pulse text-info" : "text-ink-faint"}`}
				/>
				<span
					className={`min-w-0 flex-1 truncate text-[12.5px] transition-colors duration-200 ${
						running ? "text-ink" : "text-ink-muted"
					}`}
				>
					{summary}
				</span>

				{running && (
					<span className="flex shrink-0 items-center gap-1.5 text-[11px] text-info/80">
						{elapsed > 0 && <span className="tabular-nums">{elapsed}s</span>}
						<Loader2 size={12} strokeWidth={2.2} className="dw-spin" />
					</span>
				)}
				{status === "done" && <CircleCheck size={13} strokeWidth={1.9} className="dw-pop shrink-0 text-ok/75" />}
				{status === "error" && <CircleX size={13} strokeWidth={1.9} className="dw-pop shrink-0 text-danger/85" />}

				{hasDiff && (
					<span className="dw-pop shrink-0 font-mono text-[11px]">
						<span className="text-ok">+{String(details?.added ?? 0)}</span>{" "}
						<span className="text-danger">-{String(details?.removed ?? 0)}</span>
					</span>
				)}

				<ChevronRight
					size={13}
					strokeWidth={2}
					className="shrink-0 text-ink-faint transition-transform duration-200"
					style={open ? { transform: "rotate(90deg)" } : undefined}
				/>
			</button>

			{open && (
				<div className="dw-enter border-t border-line-soft">
					{hasDiff ? (
						<DiffView hunks={details?.hunks as DiffHunk[]} path={String(details?.path ?? "")} />
					) : (
						<>
							<Section title="参数">
								<pre className="overflow-x-auto font-mono text-[11.5px] leading-relaxed text-ink-muted">
									{JSON.stringify(args, null, 2)}
								</pre>
							</Section>
							{result && (
								<Section title={status === "error" ? "错误" : running ? "输出（进行中）" : "结果"}>
									<Scroller className="max-h-[420px]" fadeColor="var(--color-shell)">
										<pre
											className={`font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap ${
												status === "error" ? "text-danger/90" : "text-ink-muted"
											}`}
										>
											{resultText(result)}
										</pre>
									</Scroller>
								</Section>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="border-b border-line-soft px-3 py-2.5 last:border-b-0">
			<div className="mb-1.5 text-[10.5px] tracking-wide text-ink-faint uppercase">{title}</div>
			{children}
		</div>
	);
}

function resultText(result: ToolResult): string {
	return result.content
		.map((block) => (block.type === "text" ? block.text : `[图片 ${block.mimeType}]`))
		.join("\n")
		.slice(0, 20000);
}
