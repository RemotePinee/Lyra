import type { DiffHunk, ToolResult } from "@lyra/core";
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
import { CodeText } from "./detail/CodeText.tsx";
import { Section } from "./detail/Section.tsx";
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
	const { command: _command, ...rest } = args as Record<string, unknown>;

	// A visible timer is the honest signal that a long command is still going.
	const startedAt = useRef(Date.now());
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 250);
		return () => clearInterval(timer);
	}, [running]);

	return (
		<div
			className={`ly-enter mb-2 overflow-hidden rounded-[10px] border transition-colors duration-200 ${
				running ? "ly-rail border-info/30 bg-card/60" : "border-line-soft bg-card/45"
			}`}
		>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="ly-scroll flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-150 hover:bg-card-hover/50"
			>
				<Icon
					size={14}
					strokeWidth={1.8}
					className={`shrink-0 transition-colors duration-200 ${running ? "ly-pulse text-info" : "text-ink-faint"}`}
				/>
				<span
					className={`min-w-0 flex-1 truncate text-label transition-colors duration-200 ${
						running ? "text-ink" : "text-ink-muted"
					}`}
				>
					{summary}
				</span>

				{running && (
					<span className="flex shrink-0 items-center gap-1.5 text-caption text-info/80">
						{elapsed > 0 && <span className="tabular-nums">{elapsed}s</span>}
						<Loader2 size={12} strokeWidth={2.2} className="ly-spin" />
					</span>
				)}
				{status === "done" && <CircleCheck size={13} strokeWidth={1.9} className="ly-pop shrink-0 text-ok/75" />}
				{status === "error" && <CircleX size={13} strokeWidth={1.9} className="ly-pop shrink-0 text-danger/85" />}

				{hasDiff && (
					<span className="ly-pop shrink-0 font-mono text-caption">
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
				<div className="ly-enter border-t border-line-soft">
					{hasDiff ? (
						<DiffView hunks={details?.hunks as DiffHunk[]} path={String(details?.path ?? "")} showPath />
					) : (
						<>
							{/*
							 * A command is shown as a command, not as a field in a JSON object.
							 *
							 * What was run is the thing you check first when something looks wrong, and
							 * `{"command": "cd … && npm install …", "timeout": 300000}` makes you read
							 * around the syntax to find it. The rest of the arguments still print as
							 * JSON below, because for every other tool that is the honest shape.
							 */}
							{typeof args.command === "string" && (
								<Section title="命令" mono tone="ink">
									<span className="mr-2 select-none text-ink-faint">$</span>
									<CodeText text={args.command} kind="shell" />
								</Section>
							)}
							{Object.keys(rest).length > 0 && (
								<Section title="参数" mono>
									<CodeText text={JSON.stringify(rest, null, 2)} kind="json" />
								</Section>
							)}
							{/*
							 * Silence is a state too.
							 *
							 * A long install prints nothing for minutes while it downloads, and a card
							 * with a command and no output section looks like a card that has lost its
							 * output. Saying so is the difference between waiting and wondering.
							 */}
							{!result && running && (
								<Section title="输出（进行中）" mono>
									<span className="text-ink-faint">等待输出…</span>
								</Section>
							)}
							{result && (
								<Section
									title={status === "error" ? "错误" : running ? "输出（进行中）" : "结果"}
									mono
									tone={status === "error" ? "danger" : "muted"}
								>
									<Scroller className="max-h-[420px]" fadeColor="var(--color-shell)">
										{resultText(result)}
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


function resultText(result: ToolResult): string {
	return result.content
		.map((block) => (block.type === "text" ? block.text : `[图片 ${block.mimeType}]`))
		.join("\n")
		.slice(0, 20000);
}
