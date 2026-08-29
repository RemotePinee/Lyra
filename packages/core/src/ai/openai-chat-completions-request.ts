/**
 * Our messages, in the shape the OpenAI Chat Completions API wants (`POST /v1/chat/completions`).
 */

import type { Message, ToolResultMessage, ToolSpec } from "../types.ts";

export function toChatCompletionsTools(tools: ToolSpec[]): unknown[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
}

function toolResultMessage(result: ToolResultMessage): unknown {
	const content = result.content
		.map((c) => (c.type === "text" ? c.text : `[image ${c.mimeType}, ${c.data.length} base64 chars]`))
		.join("\n");
	return {
		role: "tool",
		tool_call_id: result.toolCallId,
		content,
	};
}

export function toChatCompletionsMessages(systemPrompt: string, messages: Message[]): unknown[] {
	const out: unknown[] = [];
	if (systemPrompt) {
		out.push({ role: "system", content: systemPrompt });
	}

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "user") {
			const hasImages = message.content.some((c) => c.type === "image");
			if (!hasImages) {
				const text = message.content
					.filter((c) => c.type === "text")
					.map((c) => (c.type === "text" ? c.text : ""))
					.join("\n");
				out.push({ role: "user", content: text });
			} else {
				out.push({
					role: "user",
					content: message.content.map((c) =>
						c.type === "text"
							? { type: "text", text: c.text }
							: {
									type: "image_url",
									image_url: { url: `data:${c.mimeType};base64,${c.data}` },
								},
					),
				});
			}
			continue;
		}

		if (message.role === "assistant") {
			const answers = new Map<string, ToolResultMessage>();
			let after = index + 1;
			for (; after < messages.length; after++) {
				const next = messages[after];
				if (next.role !== "toolResult") break;
				if (!answers.has(next.toolCallId)) answers.set(next.toolCallId, next);
			}

			const toolCalls: unknown[] = [];
			let text = "";

			for (const c of message.content) {
				if (c.type === "text") {
					text += c.text;
				} else if (c.type === "toolCall") {
					toolCalls.push({
						id: c.id,
						type: "function",
						function: {
							name: c.name,
							arguments: c.argumentsText ?? JSON.stringify(c.arguments),
						},
					});
				}
			}

			const msg: Record<string, unknown> = { role: "assistant" };
			if (text) msg.content = text;
			else if (toolCalls.length > 0) msg.content = null;
			if (toolCalls.length > 0) msg.tool_calls = toolCalls;

			out.push(msg);

			// Interleave / follow directly with tool messages responding to tool calls
			for (const tc of toolCalls as { id: string }[]) {
				const answer = answers.get(tc.id);
				if (answer) {
					out.push(toolResultMessage(answer));
				}
			}
			continue;
		}

		if (message.role === "toolResult") {
			// If not already consumed by the assistant loop above
			const prev = messages[index - 1];
			if (prev?.role !== "assistant") {
				out.push(toolResultMessage(message));
			}
		}
	}

	return out;
}
