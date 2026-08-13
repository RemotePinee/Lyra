/**
 * OpenAI Responses API adapter (`POST /v1/responses`).
 *
 * The Responses format is item-based rather than message-based: assistant text, reasoning
 * and function calls are sibling items in one flat `input` array. Reasoning items carry an
 * opaque `encrypted_content` that must be replayed verbatim for the model to keep its chain
 * of thought across tool calls, which is why `include: ["reasoning.encrypted_content"]` is
 * always requested.
 */

import type {
	AssistantMessage,
	LlmContext,
	Message,
	ModelConfig,
	Provider,
	ProviderConfig,
	RequestOptions,
	StreamEvent,
	ThinkingLevel,
	ToolSpec,
	Usage,
} from "../types.ts";
import { emptyUsage } from "../types.ts";
import { computeCost } from "../utils/pricing.ts";
import { fetchWithRetry } from "./retry.ts";
import { parseToolArguments, readSse } from "../utils/sse.ts";
import { describeFetchError, joinUrl, truncate } from "./anthropic-messages.ts";

const REASONING_EFFORT: Record<Exclude<ThinkingLevel, "off">, string> = {
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	max: "high",
};

export const openaiResponsesProvider: Provider = {
	api: "openai-responses",
	stream: streamResponses,
};

async function* streamResponses(
	provider: ProviderConfig,
	model: ModelConfig,
	context: LlmContext,
	options: RequestOptions,
): AsyncGenerator<StreamEvent, AssistantMessage> {
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: provider.id,
		model: model.modelId,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};

	const thinkingEnabled = model.supportsThinking && options.thinking && options.thinking !== "off";

	const body: Record<string, unknown> = {
		model: model.modelId,
		input: toResponsesInput(context.messages),
		stream: true,
		// Sessions live in DeepWise's own store, not on the provider.
		store: false,
		max_output_tokens: options.maxTokens ?? model.maxOutputTokens,
		...(context.systemPrompt ? { instructions: context.systemPrompt } : {}),
		...(context.tools.length > 0 ? { tools: toResponsesTools(context.tools), tool_choice: "auto" } : {}),
		// Omitting `reasoning` does not disable thinking — several providers still reason by
		// default, so "off" has to say so explicitly. `effort: "none"` is the documented way.
		...(model.supportsThinking
			? thinkingEnabled
				? {
						reasoning: {
							effort: REASONING_EFFORT[options.thinking as Exclude<ThinkingLevel, "off">],
							summary: "auto",
						},
						include: ["reasoning.encrypted_content"],
					}
				: { reasoning: { effort: "none" } }
			: {}),
		...(options.temperature !== undefined && !thinkingEnabled ? { temperature: options.temperature } : {}),
		...model.samplingParams,
		...options.samplingParams,
	};

	options.onPayload?.(body);

	const doFetch = options.fetch ?? globalThis.fetch;
	let response: Response;
	try {
		response = await fetchWithRetry(
			doFetch,
			joinUrl(provider.baseUrl, "/v1/responses"),
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${provider.apiKey}`,
					...provider.headers,
				},
				body: JSON.stringify(body),
				signal: options.signal,
			},
			{ attempts: options.retryAttempts, signal: options.signal, onRetry: options.onRetry },
		);
	} catch (error) {
		partial.stopReason = options.signal?.aborted ? "aborted" : "error";
		partial.errorMessage = describeFetchError(error, options.signal);
		yield { type: "error", error: partial.errorMessage, message: { ...partial } };
		return partial;
	}

	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		partial.stopReason = "error";
		partial.errorMessage = `HTTP ${response.status}: ${truncate(detail, 800)}`;
		yield { type: "error", error: partial.errorMessage, message: { ...partial } };
		return partial;
	}

	yield { type: "start", partial: { ...partial } };

	/** output_index -> position in partial.content, so deltas can find their block. */
	const items = new Map<number, { kind: "text" | "thinking" | "toolCall"; contentIndex: number; raw: string }>();
	let incompleteReason: string | undefined;

	try {
		for await (const frame of readSse(response, options.signal)) {
			if (frame.data === "[DONE]") break;
			let event: Record<string, any>;
			try {
				event = JSON.parse(frame.data);
			} catch {
				continue;
			}

			const type: string = event.type ?? frame.event ?? "";
			const outputIndex: number = event.output_index ?? 0;

			switch (type) {
				case "response.output_item.added": {
					const item = event.item ?? {};
					if (item.type === "message") {
						partial.content.push({ type: "text", text: "", signature: item.id });
						items.set(outputIndex, { kind: "text", contentIndex: partial.content.length - 1, raw: "" });
						yield { type: "text_start", index: outputIndex };
					} else if (item.type === "reasoning") {
						partial.content.push({
							type: "thinking",
							thinking: "",
							signature: item.id,
							encrypted: item.encrypted_content || undefined,
						});
						items.set(outputIndex, { kind: "thinking", contentIndex: partial.content.length - 1, raw: "" });
						yield { type: "thinking_start", index: outputIndex };
					} else if (item.type === "function_call") {
						partial.content.push({
							type: "toolCall",
							// call_id is the handle the API expects back on function_call_output.
							id: String(item.call_id ?? item.id ?? ""),
							name: String(item.name ?? ""),
							arguments: {},
							argumentsText: "",
							signature: item.id,
						});
						items.set(outputIndex, { kind: "toolCall", contentIndex: partial.content.length - 1, raw: "" });
						yield {
							type: "toolcall_start",
							index: outputIndex,
							id: String(item.call_id ?? item.id ?? ""),
							name: String(item.name ?? ""),
						};
					}
					break;
				}

				case "response.output_text.delta": {
					const tracked = items.get(outputIndex);
					const target = tracked ? partial.content[tracked.contentIndex] : undefined;
					if (target?.type === "text") {
						target.text += event.delta ?? "";
						yield { type: "text_delta", index: outputIndex, delta: event.delta ?? "", partial: { ...partial } };
					}
					break;
				}

				// Providers differ: some stream a reasoning summary, some stream raw reasoning text.
				case "response.reasoning_summary_text.delta":
				case "response.reasoning_text.delta": {
					const tracked = items.get(outputIndex);
					const target = tracked ? partial.content[tracked.contentIndex] : undefined;
					if (target?.type === "thinking") {
						target.thinking += event.delta ?? "";
						yield { type: "thinking_delta", index: outputIndex, delta: event.delta ?? "", partial: { ...partial } };
					}
					break;
				}

				case "response.function_call_arguments.delta": {
					const tracked = items.get(outputIndex);
					if (!tracked) break;
					tracked.raw += event.delta ?? "";
					const target = partial.content[tracked.contentIndex];
					if (target?.type === "toolCall") target.argumentsText = tracked.raw;
					yield { type: "toolcall_delta", index: outputIndex, delta: event.delta ?? "", partial: { ...partial } };
					break;
				}

				case "response.output_item.done": {
					const tracked = items.get(outputIndex);
					if (!tracked) break;
					const item = event.item ?? {};
					const target = partial.content[tracked.contentIndex];

					if (tracked.kind === "toolCall" && target?.type === "toolCall") {
						const raw = typeof item.arguments === "string" && item.arguments ? item.arguments : tracked.raw;
						target.argumentsText = raw;
						target.arguments = parseToolArguments(raw) ?? {};
						yield { type: "toolcall_end", index: outputIndex, partial: { ...partial } };
					} else if (tracked.kind === "thinking" && target?.type === "thinking") {
						if (item.encrypted_content) target.encrypted = item.encrypted_content;
						// Non-streaming summaries only arrive on the completed item.
						if (!target.thinking && Array.isArray(item.summary)) {
							target.thinking = item.summary.map((s: { text?: string }) => s.text ?? "").join("\n");
						}
						yield { type: "thinking_end", index: outputIndex };
					} else if (tracked.kind === "text" && target?.type === "text") {
						if (!target.text && Array.isArray(item.content)) {
							target.text = item.content.map((c: { text?: string }) => c.text ?? "").join("");
						}
						yield { type: "text_end", index: outputIndex };
					}
					break;
				}

				case "response.completed":
				case "response.incomplete": {
					applyUsage(partial.usage, event.response?.usage);
					partial.responseId = event.response?.id;
					incompleteReason = event.response?.incomplete_details?.reason;
					break;
				}

				case "response.failed":
				case "error": {
					const message = event.response?.error?.message ?? event.message ?? "Unknown provider error";
					partial.stopReason = "error";
					partial.errorMessage = message;
					partial.usage = computeCost(partial.usage, model);
					yield { type: "error", error: message, message: { ...partial } };
					return partial;
				}
			}
		}
	} catch (error) {
		const aborted = options.signal?.aborted;
		partial.stopReason = aborted ? "aborted" : "error";
		partial.errorMessage = aborted ? "Aborted by user" : describeFetchError(error, options.signal);
		partial.usage = computeCost(partial.usage, model);
		yield { type: "error", error: partial.errorMessage, message: { ...partial } };
		return partial;
	}

	partial.stopReason =
		incompleteReason === "max_output_tokens"
			? "length"
			: partial.content.some((c) => c.type === "toolCall")
				? "toolUse"
				: "stop";
	partial.usage.total = partial.usage.input + partial.usage.output + partial.usage.cacheRead + partial.usage.cacheWrite;
	partial.usage = computeCost(partial.usage, model);
	yield { type: "done", message: { ...partial } };
	return partial;
}

function applyUsage(usage: Usage, raw: Record<string, any> | undefined): void {
	if (!raw) return;
	if (typeof raw.input_tokens === "number") usage.input = raw.input_tokens;
	if (typeof raw.output_tokens === "number") usage.output = raw.output_tokens;
	if (typeof raw.input_tokens_details?.cached_tokens === "number") {
		usage.cacheRead = raw.input_tokens_details.cached_tokens;
		// Cached tokens are reported inside input_tokens; keep the two buckets disjoint.
		usage.input = Math.max(0, usage.input - usage.cacheRead);
	}
	if (typeof raw.output_tokens_details?.reasoning_tokens === "number") {
		usage.reasoning = raw.output_tokens_details.reasoning_tokens;
	}
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

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
						: { type: "input_image", image_url: `data:${c.mimeType};base64,${c.data}` },
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

function toResponsesTools(tools: ToolSpec[]): unknown[] {
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		strict: false,
	}));
}
