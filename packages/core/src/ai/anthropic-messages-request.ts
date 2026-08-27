/**
 * Our messages, in the shape the Messages API wants.
 *
 * A translation and nothing else. Anthropic's shape differs from ours in two ways that matter and
 * are easy to get wrong: tool results are user-role blocks rather than their own role, and a
 * thinking block has to be replayed with its signature intact or the model rejects the turn.
 */

import type { Message, ToolResultMessage, ToolSpec } from "../types.ts";

/**
 * One block of content, in the wire shape.
 *
 * Open-ended on purpose: the API keeps adding block kinds, and a closed type would mean this file
 * has to be edited before a new one can be passed through untouched.
 */
interface AnthropicBlock {
	type: string;
	[key: string]: unknown;
}

/** One message in the wire shape. Exported because the caller assembles a request around it. */
export interface AnthropicMessage {
	role: "user" | "assistant";
	content: AnthropicBlock[];
}

/**
 * Anthropic requires tool results to arrive as `tool_result` blocks inside a *user* message,
 * and consecutive results must be merged into one message. Our flat message list has one
 * entry per result, so this collapses runs of them.
 *
 * The merged blocks are put back into the order the calls were made, which is not the order the
 * results were recorded in: tools run in parallel and each result is written down as it finishes,
 * so a history rebuilt from the log has the quickest tool first. Anthropic matches by
 * `tool_use_id` and accepts either, but the request should not differ depending on which tool won
 * the race — an identical conversation that serialises two ways defeats prompt caching for
 * everything after it.
 */
export function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
	const out: AnthropicMessage[] = [];

	for (const message of orderResultsByCall(messages)) {
		if (message.role === "user") {
			const blocks: AnthropicBlock[] = message.content.map((c) =>
				c.type === "text"
					? { type: "text", text: c.text }
					: {
							type: "image",
							source: { type: "base64", media_type: c.mimeType, data: c.data },
						},
			);
			if (blocks.length > 0) out.push({ role: "user", content: blocks });
			continue;
		}

		if (message.role === "assistant") {
			const blocks: AnthropicBlock[] = [];
			for (const c of message.content) {
				if (c.type === "text") {
					if (c.text) blocks.push({ type: "text", text: c.text });
				} else if (c.type === "thinking") {
					// A thinking block without its signature is rejected on replay, so drop it.
					if (c.redacted && c.encrypted) blocks.push({ type: "redacted_thinking", data: c.encrypted });
					else if (c.signature)
						blocks.push({
							type: "thinking",
							thinking: c.thinking,
							signature: c.signature,
						});
				} else {
					blocks.push({
						type: "tool_use",
						id: c.id,
						name: c.name,
						input: c.arguments,
					});
				}
			}
			if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
			continue;
		}

		const block: AnthropicBlock = {
			type: "tool_result",
			tool_use_id: message.toolCallId,
			content: message.content.map((c) =>
				c.type === "text"
					? { type: "text", text: c.text }
					: {
							type: "image",
							source: { type: "base64", media_type: c.mimeType, data: c.data },
						},
			),
			...(message.isError ? { is_error: true } : {}),
		};
		const last = out[out.length - 1];
		if (last?.role === "user" && last.content.every((b) => b.type === "tool_result")) last.content.push(block);
		else out.push({ role: "user", content: [block] });
	}

	return out;
}

/**
 * The same history, with each run of tool results in the order its calls were made.
 *
 * Only runs of two or more are touched, which is the only case where an order exists to get wrong,
 * and the original array is returned untouched when nothing moved — this is called on every request
 * with the whole conversation in it.
 *
 * A result whose call is not in the assistant message above it keeps its place at the end of the
 * run rather than being dropped. It is still history the model should see.
 */
function orderResultsByCall(messages: Message[]): Message[] {
	const out: Message[] = [];
	let moved = false;

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		out.push(message);
		if (message.role !== "assistant") continue;

		const run: ToolResultMessage[] = [];
		let after = index + 1;
		for (; after < messages.length; after++) {
			const next = messages[after];
			if (next.role !== "toolResult") break;
			run.push(next);
		}
		if (run.length < 2) continue;

		const spare = [...run];
		const ordered: ToolResultMessage[] = [];
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			const at = spare.findIndex((result) => result.toolCallId === content.id);
			if (at >= 0) ordered.push(...spare.splice(at, 1));
		}
		ordered.push(...spare);

		moved ||= ordered.some((result, at) => result !== run[at]);
		out.push(...ordered);
		index = after - 1;
	}

	return moved ? out : messages;
}

export function toAnthropicTools(tools: ToolSpec[]): unknown[] {
	return tools.map((tool, index) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
		// Cache the tool list too — it is stable for the whole session.
		...(index === tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
	}));
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
