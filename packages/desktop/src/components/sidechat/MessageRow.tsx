/**
 * One message in the side chat.
 *
 * Deliberately lighter than the main transcript: no timestamps, no edit affordance, no usage line.
 * This is a scratchpad you ask questions in, and the ceremony that belongs on a permanent record
 * would be noise on one that is thrown away at quit.
 */

import type { AssistantMessage, Message } from "@lyra/core";
import { useSide } from "../../sideStore.ts";
import { Markdown } from "../Markdown.tsx";
import { ThinkingBlock } from "../ThinkingBlock.tsx";
import { ToolCard } from "../ToolCard.tsx";

export function MessageRow({ message }: { message: Message }) {
	if (message.role === "toolResult") return null;

	if (message.role === "user") {
		// The main-transcript snapshots injected before each question are context for the model,
		// not something the user wrote — showing them would bury the actual conversation.
		if (message.synthetic) return null;
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		return (
			<div className="ly-enter mb-4 flex justify-end">
				<div className="max-w-[88%] rounded-[13px] rounded-br-[5px] bg-card px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-ink">
					{text}
				</div>
			</div>
		);
	}

	return <AssistantRow message={message} />;
}

function AssistantRow({ message }: { message: AssistantMessage }) {
	const toolRuns = useSide((s) => s.toolRuns);

	return (
		<div className="ly-enter mb-4">
			{message.content.map((block, index) => {
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
						<div key={index} className="mb-2">
							<Markdown text={block.text} />
						</div>
					) : null;
				}
				const run = toolRuns[block.id];
				return (
					<ToolCard
						key={block.id}
						toolName={block.name}
						args={block.arguments}
						summary={run?.summary ?? block.name}
						status={run?.status ?? (message.stopReason === "pending" ? "running" : "error")}
						result={run?.result}
					/>
				);
			})}

			{message.stopReason === "error" && message.errorMessage && (
				<div className="mt-2 rounded-[9px] border border-danger/35 bg-danger/8 px-3 py-2 text-[12px] text-danger">
					{message.errorMessage}
				</div>
			)}
		</div>
	);
}

/** Stable across re-renders while a message is still streaming into place. */
export function rowKey(message: Message, index: number): string {
	if (message.role === "toolResult") return `tr-${message.toolCallId}`;
	return `${message.role}-${message.timestamp}-${index}`;
}

/**
 * Whether the reply has stopped producing anything, so "思考中…" is the truth rather than a
 * spinner sitting under text that is already being written.
 */
export function lastIsSettled(messages: Message[]): boolean {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "assistant") return true;
	return !last.content.some((c) => (c.type === "text" && c.text) || c.type === "toolCall");
}
