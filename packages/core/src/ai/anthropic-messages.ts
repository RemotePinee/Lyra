/**
 * Anthropic Messages API adapter.
 *
 * Maps the neutral DeepWise message model onto `/v1/messages` with `stream: true`,
 * including extended thinking and its signature round-trip.
 */

import type {
	AssistantContent,
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
import { fetchWithRetry, toolCallId } from "./retry.ts";
import { parseToolArguments, readSse } from "../utils/sse.ts";

const THINKING_BUDGET: Record<Exclude<ThinkingLevel, "off">, number> = {
	minimal: 1024,
	low: 4096,
	medium: 12288,
	high: 24576,
	max: 63999,
};

interface AnthropicBlock {
	type: string;
	[key: string]: unknown;
}

interface AnthropicMessage {
	role: "user" | "assistant";
	content: AnthropicBlock[];
}

export const anthropicMessagesProvider: Provider = {
	api: "anthropic-messages",
	stream: streamAnthropic,
};

async function* streamAnthropic(
	provider: ProviderConfig,
	model: ModelConfig,
	context: LlmContext,
	options: RequestOptions,
): AsyncGenerator<StreamEvent, AssistantMessage> {
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: provider.id,
		model: model.modelId,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};

	const thinkingEnabled = model.supportsThinking && options.thinking && options.thinking !== "off";
	const maxTokens = options.maxTokens ?? model.maxOutputTokens;

	const body: Record<string, unknown> = {
		model: model.modelId,
		max_tokens: maxTokens,
		stream: true,
		messages: toAnthropicMessages(context.messages),
		...(context.systemPrompt
			? {
					system: [
						{
							type: "text",
							text: context.systemPrompt,
							// Cache the system prompt: it is identical across every turn of a session.
							cache_control: { type: "ephemeral" },
						},
					],
				}
			: {}),
		...(context.tools.length > 0 ? { tools: toAnthropicTools(context.tools) } : {}),
		...(thinkingEnabled
			? {
					thinking: {
						type: "enabled",
						budget_tokens: Math.min(THINKING_BUDGET[options.thinking as Exclude<ThinkingLevel, "off">], maxTokens - 1),
					},
				}
			: { ...(options.temperature !== undefined ? { temperature: options.temperature } : {}) }),
		...model.samplingParams,
		...options.samplingParams,
	};

	options.onPayload?.(body);

	/** Stand-in ids for calls the provider did not name, keyed by block index. */
	const inventedIds = new Map<number, string>();

	const doFetch = options.fetch ?? globalThis.fetch;
	let response: Response;
	try {
		response = await fetchWithRetry(
			doFetch,
			joinUrl(provider.baseUrl, "/v1/messages"),
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-api-key": provider.apiKey,
					"anthropic-version": "2023-06-01",
					"anthropic-beta": "prompt-caching-2024-07-31",
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

	const blocks = new Map<number, { kind: "text" | "thinking" | "toolCall"; contentIndex: number; raw: string }>();
	let stopReason: string | undefined;

	try {
		for await (const frame of readSse(response, options.signal)) {
			let event: Record<string, any>;
			try {
				event = JSON.parse(frame.data);
			} catch {
				continue;
			}

			switch (event.type) {
				case "message_start": {
					applyUsage(partial.usage, event.message?.usage);
					break;
				}

				case "content_block_start": {
					const idx: number = event.index;
					const block = event.content_block ?? {};
					if (block.type === "text") {
						partial.content.push({ type: "text", text: "" });
						blocks.set(idx, { kind: "text", contentIndex: partial.content.length - 1, raw: "" });
						yield { type: "text_start", index: idx };
					} else if (block.type === "thinking" || block.type === "redacted_thinking") {
						partial.content.push({
							type: "thinking",
							thinking: "",
							redacted: block.type === "redacted_thinking" || undefined,
							encrypted: typeof block.data === "string" ? block.data : undefined,
						});
						blocks.set(idx, { kind: "thinking", contentIndex: partial.content.length - 1, raw: "" });
						yield { type: "thinking_start", index: idx };
					} else if (block.type === "tool_use") {
						partial.content.push({
							type: "toolCall",
							id: toolCallId(block.id, idx, inventedIds),
							name: String(block.name ?? ""),
							arguments: {},
							argumentsText: "",
						});
						blocks.set(idx, { kind: "toolCall", contentIndex: partial.content.length - 1, raw: "" });
						yield { type: "toolcall_start", index: idx, id: toolCallId(block.id, idx, inventedIds), name: String(block.name ?? "") };
					}
					break;
				}

				case "content_block_delta": {
					const idx: number = event.index;
					const tracked = blocks.get(idx);
					if (!tracked) break;
					const delta = event.delta ?? {};
					const target = partial.content[tracked.contentIndex];

					if (delta.type === "text_delta" && target?.type === "text") {
						target.text += delta.text ?? "";
						yield { type: "text_delta", index: idx, delta: delta.text ?? "", partial: { ...partial } };
					} else if (delta.type === "thinking_delta" && target?.type === "thinking") {
						target.thinking += delta.thinking ?? "";
						yield { type: "thinking_delta", index: idx, delta: delta.thinking ?? "", partial: { ...partial } };
					} else if (delta.type === "signature_delta" && target?.type === "thinking") {
						target.signature = (target.signature ?? "") + (delta.signature ?? "");
					} else if (delta.type === "input_json_delta" && target?.type === "toolCall") {
						tracked.raw += delta.partial_json ?? "";
						target.argumentsText = tracked.raw;
						yield { type: "toolcall_delta", index: idx, delta: delta.partial_json ?? "", partial: { ...partial } };
					}
					break;
				}

				case "content_block_stop": {
					const idx: number = event.index;
					const tracked = blocks.get(idx);
					if (!tracked) break;
					if (tracked.kind === "toolCall") {
						const target = partial.content[tracked.contentIndex];
						if (target?.type === "toolCall") {
							target.arguments = parseToolArguments(tracked.raw) ?? {};
						}
						yield { type: "toolcall_end", index: idx, partial: { ...partial } };
					} else if (tracked.kind === "text") {
						yield { type: "text_end", index: idx };
					} else {
						yield { type: "thinking_end", index: idx };
					}
					break;
				}

				case "message_delta": {
					applyUsage(partial.usage, event.usage);
					if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
					break;
				}

				case "error": {
					const message = event.error?.message ?? "Unknown provider error";
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

	partial.stopReason = mapStopReason(stopReason, partial.content);
	partial.usage.total = partial.usage.input + partial.usage.output + partial.usage.cacheRead + partial.usage.cacheWrite;
	partial.usage = computeCost(partial.usage, model);
	yield { type: "done", message: { ...partial } };
	return partial;
}

function mapStopReason(raw: string | undefined, content: AssistantContent[]): AssistantMessage["stopReason"] {
	if (raw === "max_tokens") return "length";
	if (raw === "tool_use") return "toolUse";
	if (content.some((c) => c.type === "toolCall")) return "toolUse";
	return "stop";
}

function applyUsage(usage: Usage, raw: Record<string, any> | undefined): void {
	if (!raw) return;
	if (typeof raw.input_tokens === "number") usage.input = raw.input_tokens;
	if (typeof raw.output_tokens === "number") usage.output = raw.output_tokens;
	if (typeof raw.cache_read_input_tokens === "number") usage.cacheRead = raw.cache_read_input_tokens;
	if (typeof raw.cache_creation_input_tokens === "number") usage.cacheWrite = raw.cache_creation_input_tokens;
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

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
					: { type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } },
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
					else if (c.signature) blocks.push({ type: "thinking", thinking: c.thinking, signature: c.signature });
				} else {
					blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
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
					: { type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } },
			),
			...(message.isError ? { is_error: true } : {}),
		};
		const last = out[out.length - 1];
		if (last?.role === "user" && last.content.every((b) => b.type === "tool_result")) last.content.push(block);
		else out.push({ role: "user", content: [block] });
	}

	return out;
}

function toAnthropicTools(tools: ToolSpec[]): unknown[] {
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

export function joinUrl(base: string, path: string): string {
	const trimmedBase = base.replace(/\/+$/, "");
	// A base URL that already ends in the version segment must not get a second one.
	if (trimmedBase.endsWith("/v1") && path.startsWith("/v1/")) return trimmedBase + path.slice(3);
	return trimmedBase + path;
}

export function describeFetchError(error: unknown, signal?: AbortSignal): string {
	if (signal?.aborted) return "Aborted by user";
	if (error instanceof Error) {
		const cause = (error as { cause?: { code?: string } }).cause;
		if (cause?.code) return `${error.message} (${cause.code})`;
		return error.message;
	}
	return String(error);
}

export function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more chars)`;
}
