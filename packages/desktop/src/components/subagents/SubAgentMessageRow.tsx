/**
 * One row in the sub-agent transcript.
 *
 * Follows the main conversation's layout and mechanics:
 * - Markdown rendering
 * - Collapsible ToolGroup and ToolCard
 * - Tool loading, diff hunks and execution status derived from toolRuns
 * - ThinkingBlock
 */

import { memo } from "react";
import type { AssistantContent, AssistantMessage, Message } from "@lyra/core";
import { Markdown } from "../Markdown.tsx";
import { ThinkingBlock } from "../ThinkingBlock.tsx";
import { ToolCard } from "../ToolCard.tsx";
import { ToolGroup, describeRun } from "../ToolGroup.tsx";
import { summarizeToolCall } from "../../toolSummary.ts";
import type { ToolRun } from "../../store.ts";

export function subAgentRuns(messages: Message[]) {
	// Rebuilding toolRuns map from the sub-agent's own messages
	const runs: Record<string, ToolRun> = {};
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				runs[block.id] = {
					toolCallId: block.id,
					toolName: block.name,
					summary: summarizeToolCall(block.name, block.arguments),
					args: block.arguments,
					status: "running",
					startedAt: message.timestamp,
				};
			}
		} else if (message.role === "toolResult") {
			const run = runs[message.toolCallId];
			if (run) {
				run.status = message.isError ? "error" : "done";
				run.result = {
					content: message.content,
					details: message.details,
					isError: message.isError,
				};
				run.finishedAt = message.timestamp;
			}
		}
	}
	return runs;
}

export type SubSegment =
	| { kind: "block"; block: AssistantContent; index: number }
	| { kind: "tools"; blocks: Extract<AssistantContent, { type: "toolCall" }>[] };

export function subSegments(content: AssistantContent[]): SubSegment[] {
	const out: SubSegment[] = [];
	for (const [index, block] of content.entries()) {
		if (block.type === "toolCall") {
			const last = out[out.length - 1];
			if (last?.kind === "tools") last.blocks.push(block);
			else out.push({ kind: "tools", blocks: [block] });
		} else {
			out.push({ kind: "block", block, index });
		}
	}
	return out;
}

export const SubAgentMessageRow = memo(function SubAgentMessageRow({
	message,
	toolRuns,
	isLive,
}: {
	message: Message;
	toolRuns: Record<string, ToolRun>;
	isLive?: boolean;
}) {
	if (message.role === "toolResult") return null;

	if (message.role === "user") {
		if (message.synthetic) return null;
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		return (
			<div className="ly-enter mb-3 flex justify-end">
				<div className="max-w-[88%] rounded-[13px] rounded-br-[5px] bg-card px-3 py-2 text-label leading-relaxed whitespace-pre-wrap text-ink">
					{text}
				</div>
			</div>
		);
	}

	return <AssistantRow message={message} toolRuns={toolRuns} isLive={isLive} />;
});

function AssistantRow({
	message,
	toolRuns,
	isLive,
}: {
	message: AssistantMessage;
	toolRuns: Record<string, ToolRun>;
	isLive?: boolean;
}) {
	const items = subSegments(message.content);

	return (
		<div className="ly-enter mb-3">
			{items.map((segment, pos) => {
				if (segment.kind === "block") {
					const { block, index } = segment;
					if (block.type === "thinking") {
						return (
							<ThinkingBlock
								key={index}
								text={block.thinking}
								redacted={block.redacted === true}
								live={message.stopReason === "pending"}
							/>
						);
					}
					if (block.type === "text") {
						return block.text ? (
							<div key={index} className="mb-2 min-w-0 max-w-full overflow-hidden">
								<Markdown text={block.text} className="min-w-0 max-w-full break-words" />
							</div>
						) : null;
					}
					const run = toolRuns[block.id];
					const status = run?.status ?? (message.stopReason === "pending" ? "running" : "done");
					return (
						<ToolCard
							key={block.id}
							toolName={block.name}
							args={block.arguments}
							summary={run?.summary ?? block.name}
							status={status}
							result={run?.result}
						/>
					);
				}

				// Tool group for batch of tool calls
				const calls = segment.blocks.map((block) => {
					const run = toolRuns[block.id];
					return {
						block,
						run,
						status: run?.status ?? (message.stopReason === "pending" ? ("running" as const) : ("done" as const)),
					};
				});

				const summary = describeRun(
					calls.map(({ block }) => ({
						toolName: block.name,
						subject: subjectOf(block),
					})),
				);

				const added = calls.reduce((n, { run }) => n + diffOf(run, "added"), 0);
				const removed = calls.reduce((n, { run }) => n + diffOf(run, "removed"), 0);
				const running = isLive && calls.some((c) => c.status === "running");

				return (
					<ToolGroup key={`group-${pos}`} summary={summary} added={added} removed={removed} running={running}>
						<div className="flex flex-col gap-1">
							{calls.map(({ block, run, status }) => (
								<ToolCard
									key={block.id}
									toolName={block.name}
									args={block.arguments}
									summary={run?.summary ?? block.name}
									status={status}
									result={run?.result}
								/>
							))}
						</div>
					</ToolGroup>
				);
			})}

			{message.stopReason === "error" && message.errorMessage && (
				<div className="mt-2 rounded-[9px] border border-danger/35 bg-danger/8 px-3 py-2 text-detail text-danger">
					{message.errorMessage}
				</div>
			)}
		</div>
	);
}

function diffOf(run: ToolRun | undefined, key: "added" | "removed"): number {
	const details = run?.result?.details as { added?: number; removed?: number } | undefined;
	return Number(details?.[key] ?? 0);
}

function subjectOf(block: Extract<AssistantContent, { type: "toolCall" }>): string | undefined {
	const args = block.arguments;
	if (typeof args.path === "string") return args.path;
	if (typeof args.pattern === "string") return args.pattern;
	if (typeof args.command === "string") return args.command;
	if (typeof args.url === "string") return args.url;
	return undefined;
}
