/**
 * Message grouping for mobile transcript, aligned with Desktop grouping.ts.
 * Groups consecutive tool calls across multi-turn assistant messages & intermediate tool results
 * into a single cohesive ToolGroup block.
 */

import type { AssistantContent, AssistantMessage, Message } from "./protocol";

type ToolCallBlock = Extract<AssistantContent, { type: "toolCall" }>;

export type MobileCall = { block: ToolCallBlock; stopReason: AssistantMessage["stopReason"] };

export type MobileRun =
	| { kind: "message"; message: Message; index: number; upTo: number }
	| { kind: "tools"; id: string; calls: MobileCall[] };

function isNudge(message: Message | undefined): boolean {
	if (message?.role !== "user") return false;
	return message.content.some((c) => c.type === "text" && c.text.startsWith("（自动继续）"));
}

function spoken(content: AssistantContent[]): number {
	let end = 0;
	for (const [index, block] of content.entries()) {
		if (block.type === "text" && block.text.trim()) end = index + 1;
	}
	return end;
}

export function groupMessages(messages: Message[]): MobileRun[] {
	const out: MobileRun[] = [];

	const work = (calls: MobileCall[]) => {
		if (calls.length === 0) return;
		const last = out[out.length - 1];
		if (last?.kind === "tools") {
			last.calls.push(...calls);
		} else {
			const firstId = calls[0]?.block.id ?? `tools-${out.length}`;
			out.push({ kind: "tools", id: firstId, calls });
		}
	};

	for (const [index, message] of messages.entries()) {
		// ToolResult messages are rendered inside tool cards, not as standalone rows
		if (message.role === "toolResult") continue;

		// Synthetic continuation nudges are ignored in transcript flow
		if (message.role === "user" && (message.synthetic || isNudge(message))) continue;

		if (message.role !== "assistant") {
			out.push({ kind: "message", message, index, upTo: message.content.length });
			continue;
		}

		const said = spoken(message.content);
		const calls: MobileCall[] = [];
		for (const block of message.content.slice(said)) {
			if (block.type === "toolCall") {
				calls.push({ block, stopReason: message.stopReason });
			}
		}

		if (said > 0) {
			out.push({ kind: "message", message, index, upTo: said });
		} else if (calls.length === 0 && message.stopReason !== "pending") {
			out.push({ kind: "message", message, index, upTo: message.content.length });
		}

		work(calls);
	}

	return out;
}
