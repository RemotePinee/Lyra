/**
 * OpenAI Responses API adapter (`POST /v1/responses`).
 *
 * The Responses format is item-based rather than message-based: assistant text, reasoning
 * and function calls are sibling items in one flat `input` array. Reasoning items carry an
 * opaque `encrypted_content` that must be replayed verbatim for the model to keep its chain
 * of thought across tool calls, which is why `include: ["reasoning.encrypted_content"]` is
 * always requested.
 */

import { toResponsesInput, toResponsesTools } from "./openai-responses-request.ts";
import type {
	AssistantMessage,
	LlmContext,
	ModelConfig,
	Provider,
	ProviderConfig,
	RequestOptions,
	StreamEvent,
	Usage,
} from "../types.ts";
import { emptyUsage } from "../types.ts";
import { computeCost } from "../utils/pricing.ts";
import { fetchWithRetry, isRetryableError, retryStream, toolCallId } from "./retry.ts";
import { parseToolArguments, readSse } from "../utils/sse.ts";
import { describeFetchError, joinUrl, truncate } from "./anthropic-messages.ts";
import { resolveReasoningEffort } from "./thinking-options.ts";

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
	const startTime = Date.now();
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: provider.id,
		model: model.modelId,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: startTime,
	};

	const thinkingEnabled = model.supportsThinking && options.thinking && options.thinking !== "off";
	const reasoningEffort = thinkingEnabled ? resolveReasoningEffort(options.thinking, model) : undefined;
	const modelId = (model.modelId || model.id || "").toLowerCase();
	const isGemini = modelId.includes("gemini") || modelId.includes("gemma");

	const body: Record<string, unknown> = {
		model: model.modelId,
		input: toResponsesInput(context.messages),
		stream: true,
		// Sessions live in Lyra's own store, not on the provider.
		store: false,
		max_output_tokens: options.maxTokens ?? model.maxOutputTokens,
		...(context.systemPrompt ? { instructions: context.systemPrompt } : {}),
		...(context.tools.length > 0 ? { tools: toResponsesTools(context.tools), tool_choice: "auto" } : {}),
		// Omitting `reasoning` does not disable thinking — several providers still reason by
		// default, so "off" has to say so explicitly. `effort: "none"` is the documented way.
		// Google Gemini/Vertex API rejects `effort: "none"` with HTTP 400 (none is not a valid
		// ThinkingLevel enum value); Gemini models omit the property when thinking is off.
		...(model.supportsThinking
			? thinkingEnabled && reasoningEffort
				? {
						reasoning: {
							effort: reasoningEffort,
							summary: "auto",
						},
						include: ["reasoning.encrypted_content"],
					}
				: isGemini
					? {}
					: { reasoning: { effort: "none" } }
			: {}),
		...(options.temperature !== undefined && !thinkingEnabled ? { temperature: options.temperature } : {}),
		...model.samplingParams,
		...options.samplingParams,
	};

	options.onPayload?.(body);

	const doFetch = options.fetch ?? globalThis.fetch;

	let firstTokenTime: number | null = null;
	/** output_index -> position in partial.content, so deltas can find their block. */
	const items = new Map<
		number,
		{
			kind: "text" | "thinking" | "toolCall";
			contentIndex: number;
			raw: string;
		}
	>();
	/** Stand-in ids for calls the provider did not name, keyed by output index. */
	const inventedIds = new Map<number, string>();
	let incompleteReason: string | undefined;
	/** The provider answered with an error of its own, which no amount of retrying will change. */
	let refused = false;

	try {
		/*
		 * The whole exchange, not just the connection.
		 *
		 * A socket that dies while the reply is streaming used to end the turn outright — and the
		 * longer the reply, the wider that window, so it fell hardest on exactly the long pieces
		 * of work where losing a turn costs the most. Nothing has happened yet when it dies:
		 * tools run after a complete reply arrives, so the reply can simply be asked for again.
		 */
		yield* retryStream(
			async function* attempt() {
				const response = await fetchWithRetry(
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
					{
						attempts: options.retryAttempts,
						signal: options.signal,
						onRetry: options.onRetry,
					},
				);

				if (!response.ok) {
					const detail = await response.text().catch(() => "");
					// A plain Error, so the stream retry leaves it alone: the server said no, and
					// saying it again would get the same answer.
					throw new Error(`HTTP ${response.status}: ${truncate(detail, 800)}`);
				}

				yield { type: "start", partial: { ...partial } } as StreamEvent;

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
								partial.content.push({
									type: "text",
									text: "",
									signature: item.id,
								});
								items.set(outputIndex, {
									kind: "text",
									contentIndex: partial.content.length - 1,
									raw: "",
								});
								yield { type: "text_start", index: outputIndex };
							} else if (item.type === "reasoning") {
								partial.content.push({
									type: "thinking",
									thinking: "",
									signature: item.id,
									encrypted: item.encrypted_content || undefined,
								});
								items.set(outputIndex, {
									kind: "thinking",
									contentIndex: partial.content.length - 1,
									raw: "",
								});
								yield { type: "thinking_start", index: outputIndex };
							} else if (item.type === "function_call") {
								partial.content.push({
									type: "toolCall",
									// call_id is the handle the API expects back on function_call_output.
									id: toolCallId(item.call_id ?? item.id, outputIndex, inventedIds),
									name: String(item.name ?? ""),
									arguments: {},
									argumentsText: "",
									signature: item.id,
								});
								items.set(outputIndex, {
									kind: "toolCall",
									contentIndex: partial.content.length - 1,
									raw: "",
								});
								yield {
									type: "toolcall_start",
									index: outputIndex,
									id: toolCallId(item.call_id ?? item.id, outputIndex, inventedIds),
									name: String(item.name ?? ""),
								};
							}
							break;
						}

						case "response.output_text.delta": {
							if (firstTokenTime === null) firstTokenTime = Date.now();
							const tracked = items.get(outputIndex);
							const target = tracked ? partial.content[tracked.contentIndex] : undefined;
							if (target?.type === "text") {
								target.text += event.delta ?? "";
								yield {
									type: "text_delta",
									index: outputIndex,
									delta: event.delta ?? "",
									partial: { ...partial },
								};
							}
							break;
						}

						// Providers differ: some stream a reasoning summary, some stream raw reasoning text.
						case "response.reasoning_summary_text.delta":
						case "response.reasoning_text.delta": {
							if (firstTokenTime === null) firstTokenTime = Date.now();
							const tracked = items.get(outputIndex);
							const target = tracked ? partial.content[tracked.contentIndex] : undefined;
							if (target?.type === "thinking") {
								target.thinking += event.delta ?? "";
								yield {
									type: "thinking_delta",
									index: outputIndex,
									delta: event.delta ?? "",
									partial: { ...partial },
								};
							}
							break;
						}

						case "response.function_call_arguments.delta": {
							if (firstTokenTime === null) firstTokenTime = Date.now();
							const tracked = items.get(outputIndex);
							if (!tracked) break;
							tracked.raw += event.delta ?? "";
							const target = partial.content[tracked.contentIndex];
							if (target?.type === "toolCall") target.argumentsText = tracked.raw;
							yield {
								type: "toolcall_delta",
								index: outputIndex,
								delta: event.delta ?? "",
								partial: { ...partial },
							};
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
								yield {
									type: "toolcall_end",
									index: outputIndex,
									partial: { ...partial },
								};
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
							yield {
								type: "error",
								error: message,
								message: { ...partial },
							} as StreamEvent;
							// The provider itself refused; asking again would be told the same thing.
							refused = true;
							return;
						}
					}
				}
			},
			{
				attempts: options.retryAttempts,
				signal: options.signal,
				onRetry: options.onRetry,
				/*
				 * Everything the last attempt accumulated, cleared.
				 *
				 * The message is rebuilt from scratch by the retry, and the window replaces rather
				 * than appends — each update carries the whole message — so the abandoned half
				 * disappears the moment the new one starts arriving.
				 */
				reset: () => {
					partial.content = [];
					partial.usage = emptyUsage();
					partial.responseId = undefined;
					items.clear();
					inventedIds.clear();
					incompleteReason = undefined;
					firstTokenTime = null;
				},
			},
		);
		if (refused) return partial;
	} catch (error) {
		const aborted = options.signal?.aborted;
		partial.stopReason = aborted ? "aborted" : "error";
		partial.errorMessage = aborted ? "Aborted by user" : describeFetchError(error, options.signal);
		// Recorded here because here is the last place it is knowable; see `errorRetryable`.
		partial.errorRetryable = !aborted && isRetryableError(error);
		partial.usage = computeCost(partial.usage, model);
		partial.durationMs = Math.max(1, Date.now() - startTime);
		if (firstTokenTime !== null) {
			partial.sseDurationMs = Math.max(1, Date.now() - firstTokenTime);
		}
		yield {
			type: "error",
			error: partial.errorMessage,
			message: { ...partial },
		};
		return partial;
	}

	partial.durationMs = Math.max(1, Date.now() - startTime);
	if (firstTokenTime !== null) {
		partial.sseDurationMs = Math.max(1, Date.now() - firstTokenTime);
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
