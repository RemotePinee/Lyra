/**
 * Our messages, in the shape the Messages API wants.
 *
 * A translation and nothing else. Anthropic's shape differs from ours in two ways that matter and
 * are easy to get wrong: tool results are user-role blocks rather than their own role, and a
 * thinking block has to be replayed with its signature intact or the model rejects the turn.
 */

import type { Message, ToolSpec } from "../types.ts";

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
 */
export function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
	const out: AnthropicMessage[] = [];

	for (const message of messages) {
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
