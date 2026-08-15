import type { ToolRun } from "../../store.ts";
import { Scroller } from "../Scroller.tsx";
import { Text } from "../Text.tsx";

/**
 * What one recorded run actually consisted of.
 *
 * The list above answers "what has it done"; this answers "what exactly did it send, and what came
 * back" — the question you ask when a step did something you did not expect. Everything shown here
 * is read from what was already written down, so it says what happened rather than what the UI
 * thinks happened.
 *
 * Opened in place, under the row it belongs to, rather than in a dialog: the surrounding steps are
 * most of the context for reading one of them.
 */
export function RunDetail({ run }: { run: ToolRun }) {
	const command = typeof run.args?.command === "string" ? run.args.command : null;
	const rest = { ...run.args };
	delete rest.command;

	return (
		<div className="dw-enter mb-1 ml-[21px] rounded-md border border-line-soft bg-card/40">
			<Scroller className="max-h-[min(320px,42vh)]" contentClassName="px-2.5 py-2" fadeColor="var(--color-shell)">
				{command && (
					<Section label="命令">
						<pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-ink">
							<span className="mr-1.5 select-none text-ink-faint">$</span>
							{command}
						</pre>
					</Section>
				)}

				{Object.keys(rest).length > 0 && (
					<Section label="参数">
						<pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-ink-muted">
							{JSON.stringify(rest, null, 2)}
						</pre>
					</Section>
				)}

				<Section label={run.status === "error" ? "错误" : "输出"}>
					{run.result ? (
						<pre
							className={`font-mono text-[11px] leading-relaxed whitespace-pre-wrap ${
								run.status === "error" ? "text-danger/90" : "text-ink-muted"
							}`}
						>
							{textOf(run)}
						</pre>
					) : (
						<Text size="detail" tone="faint" mono>
							{run.status === "running" ? "等待输出…" : "没有输出"}
						</Text>
					)}
				</Section>
			</Scroller>
		</div>
	);
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="border-b border-line-soft pb-1.5 last:border-b-0 last:pb-0 [&+&]:pt-2">
			<Text size="caption" tone="faint" className="mb-1 block">
				{label}
			</Text>
			{children}
		</div>
	);
}

/** A tool result is a list of parts; only the text ones can be shown as text. */
function textOf(run: ToolRun): string {
	const parts = run.result?.content ?? [];
	const text = parts
		.filter((part) => part.type === "text")
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n")
		.trim();
	return text || "（无文本输出）";
}
