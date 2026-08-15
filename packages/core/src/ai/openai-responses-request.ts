/**
 * Our messages, in the shape the Responses API wants.
 *
 * Purely a translation: no network, no state, no decisions beyond how each kind of content maps.
 * Separated from the streaming half because the two are read for different reasons — this one when
 * a message is not being sent correctly, the other when a reply is not being read correctly.
 */

import type { Message, ToolSpec } from "../types.ts";

export function toResponsesInput(messages: Message[]): unknown[] {
	const input: unknown[] = [];

	for (const message of messages) {
		if (message.role === "user") {
			input.push({
				type: "message",
				role: "user",
				content: message.content.map((c) =>
					c.type === "text"
						? { type: "input_text", text: c.text }
						: {
								type: "input_image",
								image_url: `data:${c.mimeType};base64,${c.data}`,
							},
				),
			});
			continue;
		}

		if (message.role === "assistant") {
			for (const c of message.content) {
				if (c.type === "thinking") {
					// Replay requires the original item id; a summary alone is not accepted.
					if (!c.signature) continue;
					input.push({
						type: "reasoning",
						id: c.signature,
						summary: c.thinking ? [{ type: "summary_text", text: c.thinking }] : [],
						...(c.encrypted ? { encrypted_content: c.encrypted } : {}),
					});
				} else if (c.type === "text") {
					if (!c.text) continue;
					input.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: c.text }],
						...(c.signature ? { id: c.signature } : {}),
					});
				} else {
					input.push({
						type: "function_call",
						call_id: c.id,
						name: c.name,
						arguments: c.argumentsText ?? JSON.stringify(c.arguments),
					});
				}
			}
			continue;
		}

		// Responses only accepts a string output, so images are described rather than attached.
		const text = message.content
			.map((c) => (c.type === "text" ? c.text : `[image ${c.mimeType}, ${c.data.length} base64 chars]`))
			.join("\n");
		input.push({
			type: "function_call_output",
			call_id: message.toolCallId,
			output: text,
		});
	}

	return input;
}

export function toResponsesTools(tools: ToolSpec[]): unknown[] {
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		strict: false,
	}));
}
